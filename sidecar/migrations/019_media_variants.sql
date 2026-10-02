-- Keymaker (Fase K5): N midias por passo, com rodizio no disparo.
--
-- A midia era singular de DUAS formas diferentes: coluna em `schedule_steps`
-- (passo de sequencia) e uma linha em `media_assets` lida com LIMIT 1
-- (mensagem unica legada). A tabela filha existe porque audio PTT carrega
-- waveform, duracao e mimetype POR ARQUIVO — isso nao cabe em colunas do passo.
--
-- As colunas media_* de `schedule_steps` FICAM. O escritor grava a midia 0
-- tambem nelas (dual-write) e o leitor prefere a tabela nova, com fallback
-- para as colunas. Assim um agendamento criado nesta versao continua legivel
-- por uma versao anterior do app — o auto-updater permite voltar, e sem o
-- dual-write o agendamento apareceria sem midia lá.

CREATE TABLE IF NOT EXISTS schedule_step_media (
  id               INTEGER PRIMARY KEY,
  step_id          INTEGER REFERENCES schedule_steps(id),
  order_index      INTEGER NOT NULL DEFAULT 0,
  path             TEXT,
  mimetype         TEXT,
  kind             TEXT,
  duration_seconds INTEGER,
  waveform_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_step_media ON schedule_step_media(step_id, order_index);

-- Backfill: a midia que hoje vive nas colunas entra como variacao 0.
INSERT INTO schedule_step_media
  (step_id, order_index, path, mimetype, kind, duration_seconds, waveform_json)
SELECT id, 0, media_path, media_mimetype, media_kind, media_duration_seconds, media_waveform_json
  FROM schedule_steps
 WHERE media_path IS NOT NULL;

-- Mensagem unica legada: `media_assets` ja e tabela sem UNIQUE, entao aceita N
-- linhas por agendamento; faltava a ordem das variacoes.
ALTER TABLE media_assets ADD COLUMN order_index INTEGER;
UPDATE media_assets SET order_index = 0 WHERE order_index IS NULL;
