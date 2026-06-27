-- Fase 4 (unificada): automacoes & gatilhos.
-- trigger_type: 'message' (match no texto) | 'join' (entrou) | 'leave' (saiu).
ALTER TABLE automation_rules ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'message';
