-- Edicao de grupos recorrente (semanal, com paridade de semana opcional).
--
-- Um job de bulk e CONSUMIDO (itens pending -> ok/failed, job -> done), entao
-- um recorrente nao pode reusar a mesma linha sem apagar o historico. Esta
-- tabela e o MODELO: a cada disparo o worker cria um bulk_jobs novo a partir
-- dela, preservando o log completo de cada execucao (acao de risco = auditavel).
--
-- So operacoes de EDICAO de grupo entram aqui. Membros e create_groups ficam
-- de fora de proposito: readicionar as mesmas pessoas toda semana e o caminho
-- mais curto para denuncia/banimento, e criar em serie duplicaria grupos sem fim.
CREATE TABLE bulk_recurring (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT,                            -- titulo opcional (igual ao agendamento de mensagens)
  op             TEXT NOT NULL,                   -- set_group | set_name | set_description | set_picture | set_settings
  groups_json    TEXT NOT NULL,                   -- [{jid, name}] resolvidos na criacao
  params_json    TEXT NOT NULL,                   -- payload da edicao (nome/descricao/imagem/config + ritmo)
  recur_dow      INTEGER NOT NULL,                -- 0=Domingo .. 6=Sabado (igual Date.getDay)
  recur_time     TEXT NOT NULL,                   -- 'HH:MM' (hora local)
  recur_week_mod INTEGER,                         -- NULL/1 = toda semana | 2 = paridade (ver 016)
  recur_week_rem INTEGER,                         -- 1 = semanas impares, 0 = pares
  last_run_at    TEXT,                            -- 'YYYY-MM-DD' local do ultimo disparo (trava 1x/dia)
  status         TEXT NOT NULL DEFAULT 'active',  -- active | paused | canceled
  created_at     TEXT NOT NULL
);

-- Liga cada execucao ao modelo que a gerou (NULL = job avulso, como antes).
ALTER TABLE bulk_jobs ADD COLUMN recurring_id INTEGER REFERENCES bulk_recurring(id);

CREATE INDEX idx_bulk_jobs_recurring ON bulk_jobs(recurring_id);
