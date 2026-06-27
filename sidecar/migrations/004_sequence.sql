-- Fase 3+: sequencia de mensagens num mesmo agendamento (broadcast texto),
-- com janela de intervalo entre cada mensagem.
CREATE TABLE IF NOT EXISTS schedule_steps (
  id           INTEGER PRIMARY KEY,
  schedule_id  INTEGER REFERENCES schedules(id),
  order_index  INTEGER,
  text         TEXT
);
CREATE INDEX IF NOT EXISTS idx_steps_schedule ON schedule_steps(schedule_id, order_index);

-- Janela de intervalo (segundos) entre uma mensagem e a proxima da sequencia.
ALTER TABLE schedules ADD COLUMN step_min_s INTEGER;
ALTER TABLE schedules ADD COLUMN step_max_s INTEGER;
