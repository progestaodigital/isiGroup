-- Agendamento de acoes em massa: quando presente e no futuro, o job comeca em
-- status 'scheduled' e o worker so o promove a 'running' quando a hora chega.
-- run_at NULL = executa imediatamente (comportamento anterior).
ALTER TABLE bulk_jobs ADD COLUMN run_at TEXT;
