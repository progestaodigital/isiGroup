-- Fase 1: upsert de alvos por (conta, jid) na sincronizacao.
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_account_jid
  ON targets(account_id, jid);
