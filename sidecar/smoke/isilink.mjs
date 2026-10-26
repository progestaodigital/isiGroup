// Smoke do REDIRECIONAMENTO isiLink: roda o modulo contra um `wa` falso e um
// isiLink falso (HTTP local) e confere lotar / histerese / reabrir / convite
// redefinido / grupo retirado / erros do contrato / gate free.
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? join(HERE, '..', '..');
const TMP = process.argv[3] ?? join(tmpdir(), 'isi-smoke-isilink');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { openDatabase } = await import(`file://${ROOT}/sidecar/src/db.mjs`);
const { createIsilink } = await import(`file://${ROOT}/sidecar/src/isilink.mjs`);

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// --- isiLink falso: fila de grupos + contrato de respostas ---
const fila = []; // { grupo, ativo }
const chamadas = [];
let modo = 'normal'; // normal | 401 | plan_limit | 500
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body);
    chamadas.push({ ...b, secret: req.headers['x-webhook-secret'] ?? null });
    const reply = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (modo === '401') return reply(401, { error: 'unauthorized' });
    if (modo === '500') return reply(500, { error: 'boom' });
    const ativo = b.ativo === 'sim';
    const g = fila.find((x) => x.grupo === b.grupo);
    if (!g) {
      if (modo === 'plan_limit') return reply(200, { ok: false, action: 'ignored', reason: 'plan_limit' });
      fila.push({ grupo: b.grupo, ativo });
      return reply(200, { ok: true, action: 'added' });
    }
    if (g.ativo === ativo) return reply(200, { ok: true, action: 'unchanged' });
    g.ativo = ativo;
    return reply(200, { ok: true, action: ativo ? 'activated' : 'deactivated' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOOK = `http://127.0.0.1:${server.address().port}/api/webhooks/isigroup/abc`;

// --- WhatsApp falso: tamanho e convite por grupo ---
const grupos = {
  'a@g.us': { size: 10, code: 'AAA' },
  'b@g.us': { size: 5, code: 'BBB' },
  'c@g.us': { size: 3, code: 'CCC' },
};
const wa = {
  memberAccountForGroup: () => 1,
  adminAccountForGroup: () => 1,
  accountGroupMetadata: async (_id, jid) => ({ participants: Array.from({ length: grupos[jid].size }, (_, i) => ({ id: `${i}@lid` })) }),
  accountGroupInviteCode: async (_id, jid) => grupos[jid].code,
};

const db = openDatabase(join(TMP, 'd.db'));
db.exec(`INSERT INTO accounts (label, status) VALUES ('Chip 1','connected');
         INSERT INTO targets (account_id, jid, name, type, is_admin) VALUES
           (1,'a@g.us','Turma A','group',1), (1,'b@g.us','Turma B','group',1),
           (1,'c@g.us','Turma C','group',1), (1,'x@g.us','Sem admin','group',0);`);

const edition = { edition: 'pro' };
const il = createIsilink(db, wa, edition, { debounceMs: 30 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { await sleep(80); await il._idle(); await sleep(20); await il._idle(); };
const status = (jid) => il.list()[0].groups.find((g) => g.jid === jid);
const entra = (jid, n, tipo = 'join') => {
  grupos[jid].size += tipo === 'join' ? n : -n;
  for (let i = 0; i < n; i++) {
    const ev = { jid, sender: `${tipo}-${Date.now()}-${i}@lid`, account_id: 1 };
    il.onMembership(tipo, ev);
    il.onMembership(tipo, { ...ev, account_id: 2 }); // 2o chip: mesmo evento
  }
};

// Validacao
check('recusa "reabre com" >= maximo', il.create({ name: 'x', webhook_url: HOOK, max_members: 10, reopen_at: 10, groups: ['a@g.us'] }).error);
check('recusa grupo sem chip admin', il.create({ name: 'x', webhook_url: HOOK, max_members: 10, reopen_at: 5, groups: ['x@g.us'] }).error);
check('recusa maximo acima de 1024', il.create({ name: 'x', webhook_url: HOOK, max_members: 2000, reopen_at: 5, groups: ['a@g.us'] }).error);

// 1) Criar: status de todos, na ordem da fila
const { id } = il.create({ name: 'Lançamento', webhook_url: HOOK, secret: 's3', max_members: 12, reopen_at: 8, groups: ['a@g.us', 'b@g.us'] });
await settle();
check('ao criar envia os dois grupos, na ordem', fila.map((f) => f.grupo).join() === 'https://chat.whatsapp.com/AAA,https://chat.whatsapp.com/BBB', JSON.stringify(fila));
check('ambos abertos', fila.every((f) => f.ativo));
check('secret no header x-webhook-secret', chamadas.every((c) => c.secret === 's3'));
check('corpo usa "sim"', chamadas[0].ativo === 'sim');

// 2) Lotou
let n0 = chamadas.length;
entra('a@g.us', 2);
await settle();
check('chegou ao maximo -> "não"', chamadas.length === n0 + 1 && chamadas.at(-1).ativo === 'não', JSON.stringify(chamadas.slice(n0)));
check('fila do isiLink: A inativo', fila[0].ativo === false);
check('status salvo = nao', status('a@g.us').status === 'nao' && status('a@g.us').member_count === 12);

// 3) Histerese: caiu para 10 (acima de 8) -> nada
n0 = chamadas.length;
entra('a@g.us', 2, 'leave');
await settle();
check('entre reabre e maximo nao envia nada', chamadas.length === n0);

// 4) Reabre: caiu para 8
entra('a@g.us', 2, 'leave');
await settle();
check('caiu para "reabre com" -> "sim"', chamadas.length === n0 + 1 && chamadas.at(-1).ativo === 'sim');

// 5) Convite redefinido
n0 = chamadas.length;
grupos['b@g.us'].code = 'BBB2';
await il.resync(id);
const novas = chamadas.slice(n0);
check('convite novo: "não" na URL antiga e "sim" na nova', novas.length === 2 &&
  novas[0].grupo.endsWith('/BBB') && novas[0].ativo === 'não' &&
  novas[1].grupo.endsWith('/BBB2') && novas[1].ativo === 'sim', JSON.stringify(novas));
check('URL nova entrou no fim da fila', fila.at(-1).grupo.endsWith('/BBB2'));

// 6) Resync sem mudanca: nada enviado
n0 = chamadas.length;
await il.resync(id);
check('conferencia sem mudanca nao envia', chamadas.length === n0);

// 7) Grupo novo com fila cheia (plan_limit) e depois liberada
modo = 'plan_limit';
il.update(id, { name: 'Lançamento', webhook_url: HOOK, secret: 's3', max_members: 12, reopen_at: 8, groups: ['a@g.us', 'b@g.us', 'c@g.us'] });
await settle();
check('plan_limit: registrado como ignored, sem status', status('c@g.us').last_result === 'ignored' && status('c@g.us').status === null);
modo = 'normal';
await il.resync(id);
check('na conferencia seguinte, entra na fila', status('c@g.us').status === 'sim' && fila.at(-1).grupo.endsWith('/CCC'));

// 8) 401 nao re-tenta
modo = '401';
n0 = chamadas.length;
entra('c@g.us', 9); // 12 -> lota
await settle();
check('401: uma chamada so (sem retry)', chamadas.length === n0 + 1);
check('401: erro visivel e status mantido', /secret/.test(status('c@g.us').last_error ?? '') && status('c@g.us').status === 'sim', status('c@g.us').last_error);
modo = 'normal';
await il.resync(id);
check('apos corrigir, a conferencia envia o "não" pendente', status('c@g.us').status === 'nao');

// 9) 500 re-tenta (3x)
modo = '500';
n0 = chamadas.length;
entra('c@g.us', 5, 'leave'); // 7 -> reabre
await sleep(3500);
await settle();
check('5xx: 3 tentativas', chamadas.length === n0 + 3, String(chamadas.length - n0));
modo = 'normal';

// 10) Retirar grupo do link -> "não"
await il.resync(id);
n0 = chamadas.length;
il.update(id, { name: 'Lançamento', webhook_url: HOOK, secret: 's3', max_members: 12, reopen_at: 8, groups: ['a@g.us', 'b@g.us'] });
await settle();
const ret = chamadas.slice(n0);
check('grupo retirado recebe "não"', ret.length === 1 && ret[0].grupo.endsWith('/CCC') && ret[0].ativo === 'não', JSON.stringify(ret));
check('grupo retirado some do link', !status('c@g.us'));

// 11) Pausado: nada
il.toggle(id);
n0 = chamadas.length;
entra('a@g.us', 4);
await settle();
check('link pausado nao envia', chamadas.length === n0);
il.toggle(id);
await settle();
check('ao reativar, envia o que mudou', chamadas.length === n0 + 1 && chamadas.at(-1).ativo === 'não');

// 12) Free: motor nao age
edition.edition = 'free';
n0 = chamadas.length;
entra('a@g.us', 6, 'leave');
await settle();
await il.resync(id);
check('edicao free: nada enviado', chamadas.length === n0);

check('auditoria registrada', il.events(id).length > 5);

il.stop();
server.close();
const falhas = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - falhas}/${results.length} ok`);
process.exit(falhas ? 1 : 0);
