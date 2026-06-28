-- Milestone 2 (multi-chip): proxy opcional por conta (chip).
-- O esquema ja era multi-conta (account_id em targets/schedules/rules); aqui so
-- adicionamos os campos de proxy por chip. O pool de sessoes usa wa-session/<id>/.

ALTER TABLE accounts ADD COLUMN proxy_url TEXT;
ALTER TABLE accounts ADD COLUMN proxy_enabled INTEGER DEFAULT 0;
