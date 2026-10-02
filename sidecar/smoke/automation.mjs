// Smoke da AUTOMACAO: dispara um gatilho de verdade e confere a variacao na
// mensagem, as variaveis de contexto ({{nome}} existe aqui) e o rodizio de
// midia entre eventos seguidos.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tmpdir } from 'node:os';
import { dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';

// Raiz do projeto e diretorio temporario: derivados do proprio arquivo, para o
// smoke rodar com `node smoke/<arquivo>.mjs` sem argumento.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? pjoin(HERE, '..', '..');
const TMP = process.argv[3] ?? pjoin(tmpdir(), 'isi-smoke-automation');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const { openDatabase } = await import(`file://${ROOT}/sidecar/src/db.mjs`);
const { createAutomation } = await import(`file://${ROOT}/sidecar/src/automation.mjs`);

const db = openDatabase(join(TMP, 'd.db'));
const files = ['x', 'y'].map((n) => {
  const p = join(TMP, `${n}.jpg`);
  writeFileSync(p, Buffer.from(`midia-${n}`));
  return p;
});

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const enviados = [];
const wa = {
  isAccountConnected: () => true,
  accountSend: (id, jid, content) => {
    enviados.push({ jid, content });
    return { key: {} };
  },
  sendContent: (jid, content) => {
    enviados.push({ jid, content });
    return { key: {} };
  },
  accountIsParticipantAdmin: async () => false,
};

const editionState = { edition: 'pro' };
const auto = createAutomation(db, wa, editionState);

db.exec(`INSERT INTO accounts (label, status) VALUES ('Chip Vendas','connected');
         INSERT INTO targets (account_id, jid, name, type, is_admin) VALUES (1,'1@g.us','Turma A','group',1);`);

const rule = db
  .prepare(
    `INSERT INTO automation_rules (account_id, name, enabled, trigger_type, scope_json, account_ids_json)
     VALUES (1,'boas-vindas',1,'join','["1@g.us"]',NULL)`
  )
  .run();
db.prepare(
  `INSERT INTO automation_actions (rule_id, action_type, config_json, order_index) VALUES (?,?,?,0)`
).run(
  rule.lastInsertRowid,
  'group_message',
  JSON.stringify({
    steps: [
      {
        payload_type: 'text',
        body_json: JSON.stringify({
          text: '{{Seja bem-vindo|Bem-vindo|Que bom te ver}}, {{primeiro_nome}}! {{saudacao}}. Grupo: {{grupo}} · chip {{chip}}',
        }),
      },
      {
        payload_type: 'image',
        body_json: JSON.stringify({ caption: 'Regras {{do grupo|da casa}}' }),
        medias: [
          { stored_path: files[0], mimetype: 'image/jpeg', kind: 'image' },
          { stored_path: files[1], mimetype: 'image/jpeg', kind: 'image' },
        ],
      },
    ],
    step_min_s: 0,
    step_max_s: 0,
  })
);

// 6 entradas seguidas de pessoas diferentes.
const nomes = ['Ana Paula', 'Bruno Lima', 'Carla Souza', 'Diego Reis', 'Elisa Prado', 'Fabio Aleixo'];
for (const [i, nome] of nomes.entries()) {
  await auto.onMembership('join', {
    jid: '1@g.us',
    sender: `55119999000${i}@lid`,
    phone: `55119999000${i}`,
    name: nome,
    account_id: 1,
  });
}

const textos = enviados.filter((e) => e.content.text).map((e) => e.content.text);
const imagens = enviados.filter((e) => e.content.image);

check('disparou 2 mensagens por entrada', enviados.length === 12, `n=${enviados.length}`);
check(
  'primeiro nome resolveu em cada boas-vindas',
  nomes.every((n) => textos.some((t) => t.includes(`, ${n.split(' ')[0]}!`))),
  JSON.stringify(textos.slice(0, 2))
);
check(
  'variaveis de grupo/chip/saudacao resolveram',
  textos.every((t) => t.includes('Grupo: Turma A · chip Chip Vendas') && /(bom dia|boa tarde|boa noite)\./.test(t)),
  JSON.stringify(textos[0])
);
check('nenhuma chave vazou', textos.every((t) => !t.includes('{{')));
check(
  'variacao da saudacao nao repete em eventos seguidos',
  textos.every((t, i) => {
    if (i === 0) return true;
    const abre = (s) => s.split(',')[0];
    return abre(t) !== abre(textos[i - 1]);
  }),
  JSON.stringify(textos.map((t) => t.split(',')[0]))
);
check(
  'rodizio de midia alternou entre eventos',
  new Set(imagens.map((e) => e.content.image.toString())).size === 2,
  JSON.stringify(imagens.map((e) => e.content.image.toString()))
);
check(
  'legenda variou e ficou valida',
  imagens.every((e) => /^Regras (do grupo|da casa)$/.test(e.content.caption)),
  JSON.stringify([...new Set(imagens.map((e) => e.content.caption))])
);

// Free: sempre a 1a variacao, sem vazar chave.
editionState.edition = 'free';
enviados.length = 0;
await auto.onMembership('join', {
  jid: '1@g.us',
  sender: '5511888800000@lid',
  phone: '5511888800000',
  name: 'Zeca Silva',
  account_id: 1,
});
const naFree = enviados.filter((e) => e.content.text).map((e) => e.content.text);
check(
  'free usa a primeira variacao',
  naFree.length === 1 && naFree[0].startsWith('Seja bem-vindo, Zeca!'),
  JSON.stringify(naFree)
);

const falhas = results.filter((r) => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} verificacoes OK`);
if (falhas.length) {
  console.log('FALHAS:', falhas.map((f) => f.name).join(' | '));
  process.exit(1);
}
