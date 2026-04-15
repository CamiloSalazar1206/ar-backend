-- ═══════════════════════════════════════════════════
-- Pegar esto en Supabase → SQL Editor → Run
-- ═══════════════════════════════════════════════════

-- Tablas
CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS targets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text,
  target_index  integer NOT NULL DEFAULT 0,
  image_url     text NOT NULL,
  model_url     text NOT NULL,
  mind_url      text,
  scale         text DEFAULT '0.3 0.3 0.3',
  position      text DEFAULT '0 0 0.1',
  rotation      text DEFAULT '0 0 0',
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_targets_project ON targets(project_id, target_index);

-- Buckets de storage
INSERT INTO storage.buckets (id, name, public)
  VALUES ('targets',  'targets',  true),
         ('models',   'models',   true),
         ('compiled', 'compiled', true)
  ON CONFLICT (id) DO NOTHING;

-- Políticas de lectura pública
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'public read targets') THEN
    CREATE POLICY "public read targets"  ON storage.objects FOR SELECT USING (bucket_id = 'targets');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'public read models') THEN
    CREATE POLICY "public read models"   ON storage.objects FOR SELECT USING (bucket_id = 'models');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'public read compiled') THEN
    CREATE POLICY "public read compiled" ON storage.objects FOR SELECT USING (bucket_id = 'compiled');
  END IF;
END
$$;
