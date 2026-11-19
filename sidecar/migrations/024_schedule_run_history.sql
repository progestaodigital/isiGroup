-- Historico dos disparos de agendamentos RECORRENTES (aba Log).
-- schedule_targets e reposto a cada disparo (e na edicao/reagendamento); antes
-- do reset o resultado do disparo anterior e copiado para ca. Sem FK: nome/jid
-- sao copiados, entao o historico sobrevive a poda da sync de grupos.
CREATE TABLE IF NOT EXISTS schedule_run_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id   INTEGER NOT NULL,
  run_date      TEXT NOT NULL,      -- 'YYYY-MM-DD' local do disparo (recur_fired_at)
  option_index  INTEGER,            -- opcao sorteada (recorrente variavel)
  group_name    TEXT,
  group_jid     TEXT,
  account_id    INTEGER,
  status        TEXT,               -- sent | failed | skipped_* | pending (nao concluido) | canceled
  sent_at       TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_run_items ON schedule_run_items (schedule_id, run_date);
