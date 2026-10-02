// Smoke do DISPARO: roda o scheduler de verdade contra um `wa` falso e
// confere o que cada grupo receberia. E aqui que o refactor do K1 se prova —
// antes, o conteudo da sequencia era montado UMA vez e reusado em todos os
// grupos, e um erro nisso so apareceria num disparo real.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpdir } from 'node:os';
import { dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';

// Raiz do projeto e diretorio temporario: derivados do proprio arquivo, para o
// smoke rodar com `node smoke/<arquivo>.mjs` sem argumento.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? pjoin(HERE, '..', '..');
const TMP = process.argv[3] ?? pjoin(tmpdir(), 'isi-smoke-dispatch');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { openDatabase } = await import(`file://${ROOT}/sidecar/src/db.mjs`);
const { createScheduler } = await import(`file://${ROOT}/sidecar/src/scheduler.mjs`);

const db = openDatabase(join(TMP, 'd.db'));

// Midias reais no disco, com conteudo distinguivel.
const files = ['a', 'b', 'c'].map((n) => {
  const p = join(TMP, `${n}.jpg`);
  writeFileSync(p, Buffer.from(`midia-${n}`));
  return p;
});

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// --- wa falso: registra tudo que seria enviado ---
const enviados = [];
const wa = {
  isConnected: () => true,
  isAccountConnected: () => true,
  connectedAccountIds: () => [1],
  sendContent: (jid, content) => {
    enviados.push({ jid, acct: null, content });
    return { key: {} };
  },
  accountSend: (id, jid, content) => {
    enviados.push({ jid, acct: id, content });
    return { key: {} };
  },
};

const editionState = { edition: 'pro' };
const scheduler = createScheduler(db, wa, editionState);

// --- semeia 1 chip + 4 grupos ---
db.exec(`INSERT INTO accounts (label, status) VALUES ('Chip Um', 'connected');`);
const ins = db.prepare('INSERT INTO targets (account_id, jid, name, type, is_admin) VALUES (1,?,?,?,1)');
const nomes = ['Turma A', 'Turma B', 'Turma C', 'Turma D'];
nomes.forEach((n, i) => ins.run(`${i + 1}@g.us`, n, 'group'));
const tids = db.prepare('SELECT id FROM targets ORDER BY id').all().map((r) => r.id);

function criaSchedule({ kind, steps, options, variantMode }) {
  const r = db
    .prepare(
      `INSERT INTO schedules
         (account_id, name, scheduled_at, payload_type, content_mode, default_json, status, created_at,
          kind, recur_dow, recur_time, step_min_s, step_max_s, variant_mode, variant_count)
       VALUES (1,?,?,?, 'broadcast','{}',?,?,?,?,?,0,0,?,?)`
    )
    .run(
      `t-${kind}`,
      kind === 'once' ? new Date(Date.now() - 1000).toISOString() : null,
      'sequence',
      kind === 'once' ? 'pending' : 'active',
      new Date().toISOString(),
      kind,
      kind === 'recurring' ? new Date().getDay() : null,
      kind === 'recurring' ? '00:00' : null,
      variantMode ?? 'single',
      options ? options.length : 1
    );
  const id = r.lastInsertRowid;
  const insStep = db.prepare(
    `INSERT INTO schedule_steps (schedule_id, order_index, option_index, payload_type, body_json, media_path)
     VALUES (?,?,?,?,?,?)`
  );
  const insMedia = db.prepare(
    'INSERT INTO schedule_step_media (step_id, order_index, path, mimetype, kind) VALUES (?,?,?,?,?)'
  );
  const grupos = options ?? [steps];
  grupos.forEach((list, oi) => {
    list.forEach((st, si) => {
      const r2 = insStep.run(id, si, oi, st.type, JSON.stringify(st.body), st.medias?.[0] ?? null);
      (st.medias ?? []).forEach((m, k) => insMedia.run(r2.lastInsertRowid, k, m, 'image/jpeg', 'image'));
    });
  });
  const insT = db.prepare(
    "INSERT INTO schedule_targets (schedule_id, target_id, account_id, status) VALUES (?,?,1,'pending')"
  );
  for (const t of tids) insT.run(id, t);
  return id;
}

// ==========================================================================
// 1. Sequencia: texto com spintax + imagem com 2 midias e legenda com spintax
// ==========================================================================
criaSchedule({
  kind: 'once',
  steps: [
    { type: 'text', body: { text: '{{Oi|Ola|Opa|Eae}} {{grupo}}! Confira: https://x.com' } },
    { type: 'image', body: { caption: 'Promo {{de hoje|da semana}}' }, medias: [files[0], files[1]] },
  ],
});

await scheduler.tick();

const textos = enviados.filter((e) => e.content.text).map((e) => e.content.text);
const imagens = enviados.filter((e) => e.content.image);

check('enviou 2 mensagens para cada um dos 4 grupos', enviados.length === 8, `n=${enviados.length}`);
check('os 4 textos saem distintos (sorteio por grupo, sem repetir)', new Set(textos).size === 4, JSON.stringify(textos));
check(
  'moldura fixa intacta em todos os textos',
  textos.every((t) => /^\S+ Turma [ABCD]! Confira: https:\/\/x\.com$/.test(t)),
  JSON.stringify(textos)
);
check(
  'variavel {{grupo}} resolveu o nome de cada grupo',
  nomes.every((n) => textos.some((t) => t.includes(n))),
  JSON.stringify(textos)
);
check('nenhuma chave vazou', textos.every((t) => !t.includes('{{')));
check(
  'rodizio de midia alternou entre os 2 arquivos',
  new Set(imagens.map((e) => e.content.image.toString())).size === 2,
  JSON.stringify(imagens.map((e) => e.content.image.toString()))
);
check(
  'legendas variaram e ficaram validas',
  imagens.every((e) => /^Promo (de hoje|da semana)$/.test(e.content.caption)),
  JSON.stringify(imagens.map((e) => e.content.caption))
);

// ==========================================================================
// 2. Mensagem SEM spintax: tem de sair identica para todos
// ==========================================================================
enviados.length = 0;
criaSchedule({
  kind: 'once',
  steps: [{ type: 'text', body: { text: 'Aviso simples | sem variacao {R$ 10}' } }],
});
await scheduler.tick();
const simples = enviados.map((e) => e.content.text);
check(
  'texto sem spintax sai identico em todos os grupos',
  simples.length === 4 && new Set(simples).size === 1 && simples[0] === 'Aviso simples | sem variacao {R$ 10}',
  JSON.stringify(simples)
);

// ==========================================================================
// 3. Recorrente variavel: 3 opcoes, uma por disparo, sem repetir em sequencia
// ==========================================================================
enviados.length = 0;
const recId = criaSchedule({
  kind: 'recurring',
  variantMode: 'random',
  options: [
    [{ type: 'text', body: { text: 'OPCAO-A' } }],
    [{ type: 'text', body: { text: 'OPCAO-B1' } }, { type: 'text', body: { text: 'OPCAO-B2' } }],
    [{ type: 'image', body: { caption: 'OPCAO-C' } , medias: [files[2]] }],
  ],
});

const sequencia = [];
for (let dia = 0; dia < 7; dia++) {
  enviados.length = 0;
  await scheduler.tick();
  const marca = enviados
    .map((e) => e.content.text ?? e.content.caption ?? '')
    .find((t) => t.startsWith('OPCAO'));
  sequencia.push(marca?.slice(0, 7));
  // Simula o proximo disparo: libera o dia e repoe os alvos.
  db.prepare("UPDATE schedules SET last_run_at = '2000-01-01', recur_fired_at = NULL WHERE id = ?").run(recId);
  db.prepare("UPDATE schedule_targets SET status = 'pending', seq_step = 0 WHERE schedule_id = ?").run(recId);
}

check('cada disparo escolheu uma opcao', sequencia.every(Boolean), JSON.stringify(sequencia));
check(
  'nunca repete a mesma opcao em dois disparos seguidos',
  sequencia.every((v, i) => i === 0 || v !== sequencia[i - 1]),
  JSON.stringify(sequencia)
);
check('as 3 opcoes aparecem ao longo dos ciclos', new Set(sequencia).size === 3, JSON.stringify(sequencia));

// A opcao escolhida gruda no dia (retomada pos-crash nao troca de mensagem).
const cur = db.prepare('SELECT variant_current, variant_used FROM schedules WHERE id = ?').get(recId);
check('variant_current persistido', Number.isInteger(cur.variant_current), JSON.stringify(cur));

// Retomada do MESMO dia: metade dos alvos pendente -> mesma opcao, nao outra.
enviados.length = 0;
db.prepare("UPDATE schedule_targets SET status = 'pending', seq_step = 0 WHERE schedule_id = ? AND target_id IN (?,?)")
  .run(recId, tids[0], tids[1]);
await scheduler.tick();
const naRetomada = new Set(
  enviados.map((e) => (e.content.text ?? e.content.caption ?? '').slice(0, 7)).filter((t) => t.startsWith('OPCAO'))
);
check(
  'retomada no mesmo dia mantem a MESMA opcao',
  naRetomada.size <= 1,
  JSON.stringify([...naRetomada])
);

// ==========================================================================
// 4. Edicao free: nunca vaza chave, usa sempre a 1a variacao/opcao
// ==========================================================================
editionState.edition = 'free';
enviados.length = 0;
criaSchedule({
  kind: 'once',
  steps: [{ type: 'text', body: { text: '{{primeira|segunda|terceira}} opcao' } }],
});
await scheduler.tick();
const naFree = enviados.map((e) => e.content.text);
check(
  'free usa sempre a primeira variacao e nao vaza chaves',
  naFree.length === 4 && naFree.every((t) => t === 'primeira opcao'),
  JSON.stringify(naFree)
);

// ==========================================================================
// 5. Midia ausente do disco: re-sorteia entre as restantes
// ==========================================================================
editionState.edition = 'pro';
enviados.length = 0;
const faltante = join(TMP, 'sumiu.jpg');
criaSchedule({
  kind: 'once',
  steps: [{ type: 'image', body: { caption: 'com arquivo faltando' }, medias: [faltante, files[2]] }],
});
await scheduler.tick();
const comFalta = enviados.filter((e) => e.content.image);
check(
  'arquivo ausente: usa a variacao que existe em vez de falhar',
  comFalta.length === 4 && comFalta.every((e) => e.content.image?.toString() === 'midia-c'),
  JSON.stringify(comFalta.map((e) => e.content.image?.toString() ?? null))
);

const falhas = results.filter((r) => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} verificacoes OK`);
if (falhas.length) {
  console.log('FALHAS:', falhas.map((f) => f.name).join(' | '));
  process.exit(1);
}
