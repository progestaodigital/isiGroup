// Clona um grupo para o proximo da numeracao de uma subcategoria (usado pela
// criacao automatica do redirecionamento isiLink).
//
// No WhatsApp: cria o grupo pelo chip fixo, com os OUTROS chips do usuario que
// estao no grupo modelo (os que eram admin la sao promovidos), e copia
// descricao, foto e configuracoes do modelo. Pessoas de fora nao sao
// adicionadas: grupo novo com gente que nao pediu = denuncia = ban.
//
// No banco: o grupo novo herda categoria/semana e entra em tudo que mira a
// subcategoria — agendamentos ativos, regras de automacao, edicoes
// recorrentes e selecoes salvas que incluem QUALQUER grupo dela.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(900 + Math.floor(Math.random() * 1100)); // anti-flood entre chamadas

// Proximo nome da numeracao: o ultimo inteiro do nome + passo (2 em par/impar,
// para manter a paridade: "Lar 9" -> "Lar 11"; 1 em ambas). Mantem zeros a
// esquerda ("Lar 09" -> "Lar 11"). null se o nome nao tem numero.
export function nextGroupName(name, week) {
  const m = /(\d+)(?!.*\d)/.exec(name ?? '');
  if (!m) return null;
  const n = Number(m[1]) + (week === 'ambas' ? 1 : 2);
  return name.slice(0, m.index) + String(n).padStart(m[1].length, '0') + name.slice(m.index + m[1].length);
}

// Numero do grupo (ultimo inteiro do nome), ou -1.
export function groupNumber(name) {
  const m = /(\d+)(?!.*\d)/.exec(name ?? '');
  return m ? Number(m[1]) : -1;
}

function digits(jid) {
  return String(jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '') || null;
}

// templateJid: grupo modelo (o ultimo da subcategoria); subJids: todos os
// grupos da subcategoria. Retorna { jid, count, done[], fail[] } ou lanca se
// nem o grupo deu para criar.
export async function cloneGroup(db, wa, { templateJid, subJids, name, accountId, category, week }) {
  const reader = wa.memberAccountForGroup(templateJid);
  if (!reader) throw new Error('nenhum chip conectado no grupo modelo');
  const md = await wa.accountGroupMetadata(reader, templateJid);

  // Os outros chips do usuario no grupo modelo (conectados), com o papel de la.
  const chips = db
    .prepare(
      `SELECT t.account_id, t.is_admin, a.jid FROM targets t JOIN accounts a ON a.id = t.account_id
        WHERE t.jid = ? AND t.account_id <> ?`
    )
    .all(templateJid, accountId)
    .filter((c) => wa.isAccountConnected(c.account_id) && digits(c.jid));

  const meta = await wa.accountCreateGroup(accountId, name, chips.map((c) => `${digits(c.jid)}@s.whatsapp.net`));
  const jid = meta?.id;
  if (!jid) throw new Error('o WhatsApp nao retornou o grupo criado');
  const count = Array.isArray(meta.participants) ? meta.participants.length : 1 + chips.length;
  const now = new Date().toISOString();

  // Cache local na hora (sem esperar a sync): criador admin; os demais chips
  // como membros ate a promocao abaixo.
  const insTarget = db.prepare(
    `INSERT INTO targets (account_id, jid, name, type, is_admin, last_synced_at) VALUES (?,?,?,'group',?,?)
     ON CONFLICT(account_id, jid) DO UPDATE SET name = excluded.name, is_admin = excluded.is_admin`
  );
  insTarget.run(accountId, jid, name, 1, now);
  for (const c of chips) insTarget.run(c.account_id, jid, name, 0, now);
  db.prepare(
    `INSERT INTO group_info (jid, member_count, count_at, category, week) VALUES (?,?,?,?,?)
     ON CONFLICT(jid) DO UPDATE SET member_count = excluded.member_count, count_at = excluded.count_at,
       category = excluded.category, week = excluded.week`
  ).run(jid, count, now, category ?? null, week ?? null);

  const done = ['criado'];
  const fail = [];
  const step = async (label, fn) => {
    await pause();
    try {
      await fn();
      done.push(label);
    } catch (e) {
      fail.push(`${label}: ${e?.message ?? 'erro'}`);
    }
  };

  if (md?.desc) await step('descrição', () => wa.accountSetDescription(accountId, jid, md.desc));
  let pic = null;
  try { pic = await wa.accountGroupPicture(reader, templateJid); } catch { /* sem foto */ }
  if (pic) await step('foto', () => wa.accountSetGroupPicture(accountId, jid, pic));
  if (md?.announce) await step('só admins enviam', () => wa.accountSetGroupSetting(accountId, jid, 'announcement'));
  if (md?.restrict) await step('só admins editam', () => wa.accountSetGroupSetting(accountId, jid, 'locked'));
  if (typeof md?.memberAddMode === 'boolean') {
    await step('quem adiciona', () => wa.accountSetMemberAddMode(accountId, jid, md.memberAddMode ? 'all_member_add' : 'admin_add'));
  }
  if (md?.joinApprovalMode) await step('aprovação de entrada', () => wa.accountSetJoinApproval(accountId, jid, 'on'));

  const admins = chips.filter((c) => c.is_admin);
  if (admins.length) {
    await step(`${admins.length} chip(s) admin`, async () => {
      const phones = admins.map((c) => digits(c.jid));
      const byPhone = await wa.accountResolveGroupMembers(accountId, jid, phones);
      const ids = phones.map((p) => byPhone[p]).filter(Boolean);
      if (ids.length < phones.length) throw new Error(`${phones.length - ids.length} chip(s) nao entraram no grupo`);
      await wa.accountPromoteParticipants(accountId, jid, ids);
      for (const c of admins) db.prepare('UPDATE targets SET is_admin = 1 WHERE account_id = ? AND jid = ?').run(c.account_id, jid);
    });
  }

  done.push(...copyAutomations(db, { subJids, templateJid, jid, name, accountId }));
  return { jid, count, done, fail };
}

// Poe o grupo novo em tudo que mira a subcategoria. Retorna o resumo.
export function copyAutomations(db, { subJids, templateJid, jid, name, accountId }) {
  const sub = new Set(subJids);
  const hits = (arr) => Array.isArray(arr) && arr.some((x) => sub.has(typeof x === 'string' ? x : x?.jid));
  const parse = (s) => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };
  const out = [];
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const targetFor = db.prepare('SELECT id FROM targets WHERE jid = ? AND account_id = ?');

  db.exec('BEGIN;');
  try {
    // Agendamentos ainda por disparar (unico pendente / recorrente ativo).
    // Linha modelo: a do grupo modelo, senao a de qualquer grupo da subcategoria
    // (mantem a mensagem por alvo e o chip, se o chip estiver no grupo novo).
    const ph = subJids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT st.schedule_id, st.message_json, st.account_id, t.jid, s.kind, s.last_run_at
           FROM schedule_targets st JOIN targets t ON t.id = st.target_id JOIN schedules s ON s.id = st.schedule_id
          WHERE t.jid IN (${ph}) AND ((s.kind = 'once' AND s.status = 'pending') OR (s.kind = 'recurring' AND s.status = 'active'))
          ORDER BY (t.jid = ?) DESC`
      )
      .all(...subJids, templateJid);
    const seen = new Set();
    const ins = db.prepare('INSERT INTO schedule_targets (schedule_id, target_id, message_json, status, account_id) VALUES (?,?,?,?,?)');
    for (const r of rows) {
      if (seen.has(r.schedule_id)) continue;
      seen.add(r.schedule_id);
      const acct = r.account_id != null && targetFor.get(jid, r.account_id) ? r.account_id : accountId;
      // Recorrente que ja disparou hoje: o grupo novo entra no proximo disparo
      // (pendente hoje seria enviado atrasado pela retomada do mesmo dia).
      const status = r.kind === 'recurring' && r.last_run_at === today ? 'sent' : 'pending';
      ins.run(r.schedule_id, targetFor.get(jid, acct).id, r.message_json, status, acct);
    }
    if (seen.size) out.push(`${seen.size} agendamento(s)`);

    // Regras de automacao (escopo vazio = todos os grupos: ja vale).
    let n = 0;
    for (const r of db.prepare('SELECT id, scope_json FROM automation_rules').all()) {
      const scope = parse(r.scope_json);
      if (!hits(scope) || scope.includes(jid)) continue;
      db.prepare('UPDATE automation_rules SET scope_json = ? WHERE id = ?').run(JSON.stringify([...scope, jid]), r.id);
      n++;
    }
    if (n) out.push(`${n} automação(ões)`);

    // Edicoes recorrentes de grupo.
    n = 0;
    for (const r of db.prepare("SELECT id, groups_json FROM bulk_recurring WHERE status <> 'canceled'").all()) {
      const groups = parse(r.groups_json);
      if (!hits(groups)) continue;
      db.prepare('UPDATE bulk_recurring SET groups_json = ? WHERE id = ?').run(JSON.stringify([...groups, { jid, name }]), r.id);
      n++;
    }
    if (n) out.push(`${n} edição(ões) recorrente(s)`);

    // Selecoes salvas do picker.
    n = 0;
    for (const r of db.prepare('SELECT id, jids_json FROM group_selections').all()) {
      const jids = parse(r.jids_json);
      if (!hits(jids)) continue;
      db.prepare('UPDATE group_selections SET jids_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify([...jids, jid]), new Date().toISOString(), r.id);
      n++;
    }
    if (n) out.push(`${n} seleção(ões)`);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  return out;
}
