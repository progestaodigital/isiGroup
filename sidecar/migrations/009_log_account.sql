-- Milestone 2 / Fase F: rastreabilidade por chip.
-- Registra qual chip (account) reagiu a cada automacao no log.

ALTER TABLE automation_logs ADD COLUMN account_id INTEGER REFERENCES accounts(id);
