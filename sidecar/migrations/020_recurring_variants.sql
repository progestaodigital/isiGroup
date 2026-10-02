-- Keymaker (Fase K6): recorrente variavel.
--
-- Varias opcoes de mensagem no mesmo dia/horario; o sistema escolhe UMA por
-- disparo e, no disparo seguinte, uma diferente. Cada opcao e uma sequencia
-- completa (formatos, midias, spintax), o que `schedule_steps` ja guarda —
-- `option_index` diz a que opcao o passo pertence e `order_index` segue sendo
-- a ordem do passo DENTRO da opcao.
--
-- Nao existe `kind` novo: o motor grava kind='recurring' + variant_mode. Um
-- terceiro kind vazaria para toda query que filtra por kind (tickOnce,
-- tickRecurring, exportador, planos, MCP).
--
-- POR QUE `variant_current` E PERSISTIDO: o recorrente re-arma a MESMA linha e
-- tem retomada no mesmo dia (app caiu no meio -> continua pelos alvos que
-- faltaram). A opcao sorteada precisa GRUDAR no dia, senao metade dos grupos
-- receberia outra mensagem e `seq_step` apontaria para o passo de outra opcao.
-- Por isso o sorteio acontece na mesma transacao que marca last_run_at /
-- recur_fired_at e repoe os alvos; a retomada LE em vez de sortear.

ALTER TABLE schedules ADD COLUMN variant_mode    TEXT;    -- NULL/'single' | 'random' | 'sequential'
ALTER TABLE schedules ADD COLUMN variant_count   INTEGER; -- quantas opcoes estao cadastradas
ALTER TABLE schedules ADD COLUMN variant_current INTEGER; -- opcao do disparo em curso (gruda no dia)
ALTER TABLE schedules ADD COLUMN variant_used    TEXT;    -- JSON dos indices ja sorteados no ciclo

-- NULL/0 = opcao unica: todo agendamento existente se comporta igual.
ALTER TABLE schedule_steps ADD COLUMN option_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_steps_option ON schedule_steps(schedule_id, option_index, order_index);
