require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@supabase/supabase-js');

/* ── Supabase client (service role → acceso total) ── */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app    = express();
const upload = multer({ storage: multer.memoryStorage() }); // archivos en RAM

app.use(cors());
app.use(express.json());

/* ════════════════════════════════════════════════════
   POST /api/upload
   Body (multipart): name, image, model, scale, position, rotation
   Crea o usa un proyecto existente, guarda target.
   Responde: { projectId, targetId }
════════════════════════════════════════════════════ */
app.post('/api/upload', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'model', maxCount: 1 }
]), async (req, res) => {
  try {
    const { projectId, projectName, targetName, scale, position, rotation } = req.body;
    const imageFile = req.files?.image?.[0];
    const modelFile = req.files?.model?.[0];

    if (!imageFile || !modelFile) {
      return res.status(400).json({ error: 'Se requieren imagen y modelo' });
    }

    /* ── 1. Resolver proyecto ── */
    let pid = projectId;
    if (!pid) {
      const { data: proj, error: projErr } = await supabase
        .from('projects')
        .insert({ name: projectName || 'Proyecto sin nombre' })
        .select('id')
        .single();
      if (projErr) throw projErr;
      pid = proj.id;
    }

    /* ── 2. Subir imagen a storage/targets ── */
    const imgExt  = imageFile.originalname.split('.').pop();
    const imgPath = `${pid}/${uuidv4()}.${imgExt}`;
    const { error: imgErr } = await supabase.storage
      .from('targets')
      .upload(imgPath, imageFile.buffer, { contentType: imageFile.mimetype });
    if (imgErr) throw imgErr;

    const { data: { publicUrl: imageUrl } } = supabase.storage
      .from('targets')
      .getPublicUrl(imgPath);

    /* ── 3. Subir modelo a storage/models ── */
    const mdlExt  = modelFile.originalname.split('.').pop();
    const mdlPath = `${pid}/${uuidv4()}.${mdlExt}`;
    const { error: mdlErr } = await supabase.storage
      .from('models')
      .upload(mdlPath, modelFile.buffer, { contentType: 'model/gltf-binary' });
    if (mdlErr) throw mdlErr;

    const { data: { publicUrl: modelUrl } } = supabase.storage
      .from('models')
      .getPublicUrl(mdlPath);

    /* ── 4. Contar targets actuales del proyecto para asignar índice ── */
    const { count } = await supabase
      .from('targets')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', pid);

    /* ── 5. Guardar target en DB ── */
    const { data: target, error: tErr } = await supabase
      .from('targets')
      .insert({
        project_id:   pid,
        name:         targetName || imageFile.originalname,
        target_index: count ?? 0,
        image_url:    imageUrl,
        model_url:    modelUrl,
        scale:        scale    || '0.3 0.3 0.3',
        position:     position || '0 0 0.1',
        rotation:     rotation || '0 0 0'
      })
      .select('id')
      .single();
    if (tErr) throw tErr;

    res.json({ projectId: pid, targetId: target.id, imageUrl, modelUrl });

  } catch (err) {
    console.error('[/api/upload]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/project/:id
   Devuelve config completa del proyecto:
   { mind_url (si existe), targets: [{model_url, scale, position, rotation}] }
════════════════════════════════════════════════════ */
app.get('/api/project/:id', async (req, res) => {
  try {
    const { id } = req.params;

    /* Proyecto */
    const { data: project, error: pErr } = await supabase
      .from('projects')
      .select('id, name, description')
      .eq('id', id)
      .single();
    if (pErr) return res.status(404).json({ error: 'Proyecto no encontrado' });

    /* Targets ordenados por índice */
    const { data: targets, error: tErr } = await supabase
      .from('targets')
      .select('target_index, image_url, model_url, mind_url, scale, position, rotation, name')
      .eq('project_id', id)
      .order('target_index');
    if (tErr) throw tErr;

    /* El .mind compilado se toma del primer target que lo tenga
       (todos del proyecto comparten el mismo .mind) */
    const mind_url = targets.find(t => t.mind_url)?.mind_url ?? null;

    res.json({
      id:       project.id,
      name:     project.name,
      mind_url,
      targets:  targets.map(t => ({
        targetIndex: t.target_index,
        name:        t.name,
        image_url:   t.image_url,
        model_url:   t.model_url,
        scale:       t.scale,
        position:    t.position,
        rotation:    t.rotation
      }))
    });

  } catch (err) {
    console.error('[/api/project/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════
   POST /api/project/:id/mind
   Body: { mindBuffer: "<base64>" }
   El frontend compila el .mind y lo sube aquí para
   que otros usuarios lo descarguen directo (sin recompilar).
════════════════════════════════════════════════════ */
app.post('/api/project/:id/mind', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { id }         = req.params;
    const { mindBuffer } = req.body; // base64

    if (!mindBuffer) return res.status(400).json({ error: 'mindBuffer requerido' });

    const buffer   = Buffer.from(mindBuffer, 'base64');
    const mindPath = `${id}/targets.mind`;

    /* Subir o reemplazar el .mind en storage/compiled */
    await supabase.storage.from('compiled').remove([mindPath]);
    const { error: upErr } = await supabase.storage
      .from('compiled')
      .upload(mindPath, buffer, { contentType: 'application/octet-stream' });
    if (upErr) throw upErr;

    const { data: { publicUrl: mindUrl } } = supabase.storage
      .from('compiled')
      .getPublicUrl(mindPath);

    /* Actualizar todos los targets del proyecto con la mind_url */
    await supabase
      .from('targets')
      .update({ mind_url: mindUrl })
      .eq('project_id', id);

    res.json({ mindUrl });

  } catch (err) {
    console.error('[/api/project/:id/mind]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/projects  (listado rápido para panel admin)
════════════════════════════════════════════════════ */
app.get('/api/projects', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, description, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════
   GET /api/config
   Devuelve la URL pública de Supabase y el anon key
   para que el frontend pueda inicializar su cliente.
════════════════════════════════════════════════════ */
app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl:  process.env.SUPABASE_URL,
    supabaseAnon: process.env.ANON_KEY
  });
});

/* ── Arrancar servidor ── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AR Backend corriendo en http://localhost:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL}`);
});
