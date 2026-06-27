-- Fase 2+: agendamentos recorrentes (dia da semana + horario).
-- kind: 'once' (disparo unico, ja existente) | 'recurring' (semanal).
ALTER TABLE schedules ADD COLUMN kind        TEXT NOT NULL DEFAULT 'once';
ALTER TABLE schedules ADD COLUMN recur_dow   INTEGER;   -- 0=Domingo .. 6=Sabado (igual Date.getDay)
ALTER TABLE schedules ADD COLUMN recur_time  TEXT;       -- 'HH:MM' (hora local)
ALTER TABLE schedules ADD COLUMN last_run_at TEXT;        -- 'YYYY-MM-DD' local do ultimo disparo
