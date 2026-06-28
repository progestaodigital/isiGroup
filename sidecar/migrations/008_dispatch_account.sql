-- Milestone 2 / Fase D: disparo group-first.
-- Cada alvo de um agendamento passa a saber QUAL chip o envia (account_id).
-- NULL = conta primaria (comportamento single-chip preservado).
-- O status 'skipped_no_coverage' marca grupos sem chip selecionado que os cubra.

ALTER TABLE schedule_targets ADD COLUMN account_id INTEGER REFERENCES accounts(id);
