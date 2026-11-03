// Smoke da CRIACAO AUTOMATICA de grupo no redirecionamento isiLink: quando
// todos os grupos de uma subcategoria passam de 60%, o chip criador cria o
// proximo da numeracao e copia configuracoes + automacoes. Roda contra um `wa`
// falso e um isiLink falso (HTTP local).
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? join(HERE, '..', '..');
const TMP = process.argv[3] ?? join(tmpdir(), 'isi-smoke-isilink-grow');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { openDatabase } = await import(`file://${ROOT}/sidecar/src/db.mjs`);
const { createIsilink } = await import(`file://${ROOT}/sidecar/src/isilink.mjs`);
const { nextGroupName } = await import(`file://${ROOT}/sidecar/src/groupclone.mjs`);

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// Numeracao
check('ímpar 9 -> 11', nextGroupName('Lar 9', 'impar') === 'Lar 11');
check('par 10 -> 12', nextGroupName('Lar 10', 'par') === 'Lar 12');
check('ambas 5 -> 6', nextGroupName('Lar 5', 'ambas') === 'Lar 6');
check('mantem zero a esquerda', nextGroupName('Lar 09', 'impar') === 'Lar 11' && nextGroupName('Lar 03', 'impar') === 'Lar 05');
check('usa o ULTIMO numero do nome', nextGroupName('Lar 2026 #9 ímpar', 'impar') === 'Lar 2026 #11 ímpar');
check('sem numero -> null', nextGroupName('Lar', 'impar') === null);

// --- isiLink falso ---
const chamadas = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    chamadas.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, action: 'added' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${server.address().port}/api/webhooks/isigroup/abc`;

// --- WhatsApp falso ---
const grupos = {
  'i7@g.us': { size: 70, code: 'I7', md: {} },
  'i9@g.us': { size: 50, code: 'I9', md: { desc: 'Bem-vindo ao Lar', announce: true, restrict: true, memberAddMode: false, joinApprovalMode: true } },
  'p8@g.us': { size: 30, code: 'P8', md: {} },
};
const ops = [];
let seq = 0;
const wa = {
  memberAccountForGroup: () => 1,
  adminAccountForGroup: () => 1,
  isAccountConnected: () => true,
  accountGroupMetadata: async (_a, jid) => ({ ...grupos[jid].md, participants: Array.from({ length: grupos[jid].size }, (_, i) => ({ id: `${i}@lid` })) }),
  accountGroupInviteCode: async (_a, jid) => grupos[jid].code,
  accountCreateGroup: async (acct, subject, ps) => {
    const jid = `novo${++seq}@g.us`;
    grupos[jid] = { size: 1 + ps.length, code: `N${seq}`, md: {} };
    ops.push({ op: 'create', acct, subject, ps });
    return { id: jid, participants: Array.from({ length: 1 + ps.length }, (_, i) => ({ id: `${i}@lid` })) };
  },
  accountSetDescription: async (a, jid, d) => ops.push({ op: 'desc', jid, d }),
  accountGroupPicture: async () => Buffer.from('foto'),
  accountSetGroupPicture: async (a, jid) => ops.push({ op: 'pic', jid }),
  accountSetGroupSetting: async (a, jid, s) => ops.push({ op: 'setting', jid, s }),
  accountSetMemberAddMode: async (a, jid, m) => ops.push({ op: 'addmode', jid, m }),
  accountSetJoinApproval: async (a, jid, m) => ops.push({ op: 'approval', jid, m }),
  accountResolveGroupMembers: async (a, jid, phones) => Object.fromEntries(phones.map((p) => [p, `${p}@lid`])),
  accountPromoteParticipants: async (a, jid, ids) => ops.push({ op: 'promote', jid, ids }),
};

const db = openDatabase(join(TMP, 'd.db'));
db.exec(`
  INSERT INTO accounts (id, label, jid, status) VALUES (1,'Chip 1','5511111111111:3@s.whatsapp.net','connected'),
                                                       (2,'Chip 2','5522222222222@s.whatsapp.net','connected');
  INSERT INTO targets (id, account_id, jid, name, type, is_admin) VALUES
    (1,1,'i7@g.us','Lar 7','group',1), (2,1,'i9@g.us','Lar 9','group',1), (3,2,'i9@g.us','Lar 9','group',1),
    (4,1,'p8@g.us','Lar 8','group',1);
  INSERT INTO group_info (jid, category, week) VALUES ('i7@g.us','lar','impar'), ('i9@g.us','lar','impar'), ('p8@g.us','lar','par');
  INSERT INTO schedules (id, name, kind, status, recur_dow, recur_time) VALUES (1,'semanal','recurring','active',1,'10:00');
  INSERT INTO schedules (id, name, kind, status) VALUES (2,'ja enviado','once','sent'), (3,'do par','once','pending');
  INSERT INTO schedule_targets (schedule_id, target_id, message_json, status, account_id) VALUES
    (1,3,'{"text":"oi"}','sent',2), (2,1,NULL,'sent',1), (3,4,NULL,'pending',1);
  INSERT INTO automation_rules (id, name, enabled, scope_json) VALUES (1,'impares',1,'["i7@g.us"]'), (2,'pares',1,'["p8@g.us"]'), (3,'todos',1,'[]');
  INSERT INTO bulk_recurring (op, groups_json, params_json, recur_dow, recur_time, created_at)
    VALUES ('set_description','[{"jid":"i9@g.us","name":"Lar 9"}]','{}',1,'10:00','x');
  INSERT INTO group_selections (name, jids_json, created_at, updated_at) VALUES ('Lar', '["i9@g.us","p8@g.us"]','x','x');
`);

const il = createIsilink(db, wa, { edition: 'pro' }, { debounceMs: 30 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(80); await il._idle(); await sleep(20); await il._idle(); };
const entra = (jid, n) => {
  grupos[jid].size += n;
  for (let i = 0; i < n; i++) il.onMembership('join', { jid, sender: `j-${Date.now()}-${i}@lid` });
};

const { id } = il.create({ name: 'Lar', webhook_url: HOOK, max_members: 100, reopen_at: 90, creator_account_id: 1, groups: ['i7@g.us', 'i9@g.us', 'p8@g.us'] });
await settle();
check('abaixo de 60% em um ímpar: nao cria', !ops.some((o) => o.op === 'create'));

entra('i9@g.us', 11); // 61 -> todos os impares >= 60
await settle();
const created = ops.filter((o) => o.op === 'create');
check('cria um grupo so', created.length === 1, JSON.stringify(created));
const c = created[0] ?? {};
check('nome segue a numeracao ímpar (9 -> 11)', c.subject === 'Lar 11');
check('criado pelo chip fixo, com o outro chip do modelo', c.acct === 1 && c.ps?.join() === '5522222222222@s.whatsapp.net');
const nj = 'novo1@g.us';
const on = (op) => ops.filter((o) => o.op === op && o.jid === nj);
check('copia descricao e foto', on('desc')[0]?.d === 'Bem-vindo ao Lar' && on('pic').length === 1);
check('copia configuracoes', on('setting').map((o) => o.s).join() === 'announcement,locked' && on('addmode')[0]?.m === 'admin_add' && on('approval')[0]?.m === 'on');
check('promove o chip que era admin no modelo', on('promote')[0]?.ids.join() === '5522222222222@lid');
const gi = db.prepare('SELECT category, week FROM group_info WHERE jid = ?').get(nj);
check('herda categoria e semana', gi?.category === 'lar' && gi?.week === 'impar');

const st = db.prepare('SELECT st.*, t.jid FROM schedule_targets st JOIN targets t ON t.id = st.target_id WHERE t.jid = ?').all(nj);
check('entra no recorrente ativo, com a mensagem e o chip do modelo', st.length === 1 && st[0].schedule_id === 1 && st[0].message_json === '{"text":"oi"}' && st[0].account_id === 2 && st[0].status === 'pending', JSON.stringify(st));
const scope = (rid) => JSON.parse(db.prepare('SELECT scope_json FROM automation_rules WHERE id = ?').get(rid).scope_json);
check('entra na automacao de qualquer grupo da subcategoria', scope(1).includes(nj));
check('nao entra na automacao do par nem muda a de todos', !scope(2).includes(nj) && scope(3).length === 0);
check('entra na edicao recorrente', JSON.parse(db.prepare('SELECT groups_json FROM bulk_recurring').get().groups_json).some((g) => g.jid === nj));
check('entra na selecao salva', JSON.parse(db.prepare('SELECT jids_json FROM group_selections').get().jids_json).includes(nj));

const last = chamadas.at(-1);
check('vai para o isiLink no fim da fila com "sim" e semana ímpar', last?.grupo.endsWith('/N1') && last.ativo === 'sim' && last.semana === 'ímpar', JSON.stringify(last));
check('entra no link, no fim', il.list()[0].groups.at(-1).jid === nj);
check('auditoria registra a criacao', il.events(id).some((e) => e.result === 'created' && e.jid === nj));

// Par nao foi afetado; nova conferencia nao cria de novo (o grupo novo tem vaga).
await il.resync(id);
check('nao cria de novo nem cria par', ops.filter((o) => o.op === 'create').length === 1);

// Par enche -> cria o par seguinte (8 -> 10)
entra('p8@g.us', 40);
await settle();
check('par cheio cria "Lar 10"', ops.filter((o) => o.op === 'create').at(-1)?.subject === 'Lar 10');

il.stop();
server.close();
const falhas = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
