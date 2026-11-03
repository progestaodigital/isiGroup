-- Criacao automatica de grupo no redirecionamento isiLink: quando todos os
-- grupos de uma subcategoria (categoria + semana) do link passam de 60% do
-- maximo, o chip fixo abaixo cria o proximo grupo da numeracao, copiando
-- configuracoes e automacoes do ultimo. NULL = nao cria.
-- As criacoes ficam na auditoria (isilink_events, result created|create_failed).
ALTER TABLE isilink_links ADD COLUMN creator_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
