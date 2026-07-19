-- 012 — Correcoes de confiabilidade do envio recorrente:
--
-- * targets.announce: 1 quando o grupo esta em modo "so admins enviam"
--   (campo `announce` da metadata do Baileys). Preenchido na proxima sync;
--   NULL = desconhecido (roteamento nao restringe).
--
-- * schedules.recur_fired_at: data local (YYYY-MM-DD) em que o disparo
--   recorrente de fato COMECOU. Distingue "rodou hoje (talvez incompleto —
--   pode retomar pendentes)" de "criado hoje para pular o dia" (que so
--   preenche last_run_at). Base da retomada no mesmo dia apos queda.

ALTER TABLE targets ADD COLUMN announce INTEGER;
ALTER TABLE schedules ADD COLUMN recur_fired_at TEXT;
