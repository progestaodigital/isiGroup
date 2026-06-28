-- Refinamentos (B) + limpeza (C).

-- C/#8: tabelas nunca usadas. O webhook virou acao de automacao; eventos de
-- entrada/saida sao tratados em tempo real (sem persistir em membership_events).
DROP TABLE IF EXISTS membership_events;
DROP TABLE IF EXISTS webhooks;

-- B/#3: selecao de chips por automacao (o "chip que responde" filtra por estes).
ALTER TABLE automation_rules ADD COLUMN account_ids_json TEXT;

-- C/#7: resumability de sequencia — ultimo passo ja enviado por alvo.
ALTER TABLE schedule_targets ADD COLUMN seq_step INTEGER DEFAULT 0;

-- B/#6: rodizio por execucao — pool de chips selecionado + offset de rotacao.
ALTER TABLE schedules ADD COLUMN account_ids_json TEXT;
ALTER TABLE schedules ADD COLUMN rotation_offset INTEGER DEFAULT 0;
