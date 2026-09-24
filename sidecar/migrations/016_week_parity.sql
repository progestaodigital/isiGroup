-- Recorrencia por paridade da semana do ano (opcional).
-- Combina com recur_dow + recur_time: "toda segunda de semana impar".
--
-- Guardado como divisor/resto em vez de um enum 'odd'/'even': paridade e
-- mod 2 (resto 1 = impares, resto 0 = pares) e, se um dia quisermos
-- "a cada 3/4 semanas", basta mudar a UI — o motor ja aceita.
--
-- NULL (padrao) = toda semana: agendamentos existentes nao mudam de
-- comportamento. Numero da semana = ISO-8601 (semana comeca na segunda,
-- semana 1 = a que contem a primeira quinta-feira do ano).
ALTER TABLE schedules ADD COLUMN recur_week_mod INTEGER;  -- NULL/1 = toda semana | 2 = quinzenal
ALTER TABLE schedules ADD COLUMN recur_week_rem INTEGER;  -- resto esperado de (semana ISO % mod): 0 = pares, 1 = impares
