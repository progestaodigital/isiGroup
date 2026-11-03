-- Classificacao do grupo: categoria livre (ex.: "lar") + subcategoria fixa de
-- semana, enviada ao isiLink no campo "semana". Fica em group_info (por jid,
-- independente de chip) porque a sync de alvos poda `targets`.
ALTER TABLE group_info ADD COLUMN category TEXT;
ALTER TABLE group_info ADD COLUMN week TEXT; -- par | impar | ambas | NULL = nao classificado

-- Ultima semana ACEITA pelo isiLink para o grupo (reenvia so a semana quando muda).
ALTER TABLE isilink_groups ADD COLUMN last_week TEXT;
