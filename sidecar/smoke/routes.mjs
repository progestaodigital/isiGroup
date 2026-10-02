// Smoke test do Keymaker: sobe o sidecar contra um DB temporario, semeia
// chips/grupos e exercita as rotas novas (preview, opcoes, multi-midia).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { tmpdir } from 'node:os';
import { dirname, join as pjoin } from 'node:path';
import { fileURLToPath } from 'node:url';

// Raiz do projeto e diretorio temporario: derivados do proprio arquivo, para o
// smoke rodar com `node smoke/<arquivo>.mjs` sem argumento.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? pjoin(HERE, '..', '..');
const TMP = process.argv[3] ?? pjoin(tmpdir(), 'isi-smoke-routes');
const TOKEN = 'smoketoken';

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const DB = join(TMP, 'test.db');

// Arquivos de "midia" falsos (o sidecar so le bytes no disparo).
const m1 = join(TMP, 'a.jpg');
const m2 = join(TMP, 'b.jpg');
writeFileSync(m1, Buffer.from('imagem-a'));
writeFileSync(m2, Buffer.from('imagem-b'));

const child = spawn(process.execPath, ['index.mjs'], {
  cwd: join(ROOT, 'sidecar'),
  env: { ...process.env, ISI_SIDECAR_TOKEN: TOKEN, ISI_DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout esperando o sidecar:\n' + out)), 30000);
  const onData = (b) => {
    out += b.toString();
    const m = out.match(/__SIDECAR_READY__(\{.*\})/);
    if (m) {
      clearTimeout(t);
      resolve(JSON.parse(m[1]).port);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (c) => reject(new Error(`sidecar saiu com ${c}:\n${out}`)));
});

const api = async (path, init = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { 'x-isi-token': TOKEN, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${name}${extra ? ` — ${extra}` : ''}`);
};

try {
  // --- migrations aplicadas ---
  const health = await api('/health');
  check('health responde', health.status === 200 && health.body?.ok);
  check(
    'migrations aplicadas',
    health.body?.migrations_applied >= 20,
    `migrations=${health.body?.migrations_applied}`
  );

  // --- gate Pro no motor ---
  const freePreview = await api('/spin/preview', { method: 'POST', body: JSON.stringify({ text: '{{a|b}}' }) });
  check('preview bloqueado na free', freePreview.status === 403, `status=${freePreview.status}`);

  await api('/edition', { method: 'POST', body: JSON.stringify({ edition: 'pro' }) });

  // --- preview ---
  const p1 = await api('/spin/preview', {
    method: 'POST',
    body: JSON.stringify({
      text: '{{oi, tudo bem?|ola, como vai?|opa, tudo bem com voce?}}\n\n{{Fabio aqui|Fabio falando|e o Fabio|Fabio entrando em contato}}',
    }),
  });
  check('preview conta 12 combinacoes', p1.body?.total === 12, `total=${p1.body?.total}`);
  check('preview devolve 3 amostras distintas', new Set(p1.body?.samples ?? []).size === 3);

  const p2 = await api('/spin/preview', { method: 'POST', body: JSON.stringify({ text: 'oi {{a|b' }) });
  check('preview acusa bloco aberto', p2.body?.ok === false && p2.body.errors.length > 0);

  const p3 = await api('/spin/preview', { method: 'POST', body: JSON.stringify({ text: 'Ola {{nome}}' }) });
  check('preview avisa variavel fora do contexto', (p3.body?.warnings ?? []).length === 1, JSON.stringify(p3.body?.warnings));

  // --- semeia chip + grupos (2a conexao; WAL permite escrita concorrente) ---
  const seed = new DatabaseSync(DB);
  seed.exec(
    `INSERT INTO accounts (label, status) VALUES ('Chip 1', 'disconnected');
     INSERT INTO targets (account_id, jid, name, type, is_admin)
       VALUES (1, '1@g.us', 'Grupo Um', 'group', 1), (1, '2@g.us', 'Grupo Dois', 'group', 1);`
  );
  const tids = seed.prepare('SELECT id FROM targets ORDER BY id').all().map((r) => r.id);
  seed.close();

  // --- agendamento com spintax + 2 midias no passo ---
  const created = await api('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'keymaker',
      kind: 'once',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      content_mode: 'broadcast',
      payload_type: 'sequence',
      steps: [
        { type: 'text', text: '{{Oi|Ola}} {{grupo}}! Confira: https://x.com' },
        {
          type: 'image',
          text: 'Promo {{de hoje|da semana}}',
          medias: [
            { stored_path: m1, mimetype: 'image/jpeg', kind: 'image', duration_seconds: null, waveform_json: null },
            { stored_path: m2, mimetype: 'image/jpeg', kind: 'image', duration_seconds: null, waveform_json: null },
          ],
        },
      ],
      step_min_s: 1,
      step_max_s: 2,
      targets: tids.map((id) => ({ target_id: id, account_id: 1 })),
    }),
  });
  check('cria agendamento com spintax + 2 midias', created.status === 201, JSON.stringify(created.body));

  const det = await api(`/schedules/${created.body?.id}`);
  check('detalhe traz 2 passos', det.body?.steps?.length === 2);
  check('detalhe traz as 2 midias do passo', det.body?.steps?.[1]?.medias?.length === 2);
  check('detalhe traz media singular (compat)', !!det.body?.steps?.[1]?.media?.stored_path);
  check('detalhe traz options', Array.isArray(det.body?.options) && det.body.options.length === 1);

  // --- recusa sintaxe quebrada na porta ---
  const bad = await api('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'ruim',
      kind: 'once',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      content_mode: 'broadcast',
      payload_type: 'text',
      steps: [{ type: 'text', text: 'oi {{a|b' }],
      targets: tids.map((id) => ({ target_id: id })),
    }),
  });
  check('recusa bloco aberto ao salvar', bad.status === 400, JSON.stringify(bad.body));

  // --- recorrente variavel: 3 opcoes ---
  const rec = await api('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'variavel',
      kind: 'recurring',
      recur_dow: 1,
      recur_time: '09:00',
      content_mode: 'broadcast',
      payload_type: 'sequence',
      variant_mode: 'random',
      options: [
        { steps: [{ type: 'text', text: 'Opcao A {{1|2}}' }] },
        { steps: [{ type: 'text', text: 'Opcao B' }, { type: 'text', text: 'Opcao B parte 2' }] },
        {
          steps: [
            {
              type: 'image',
              text: 'Opcao C',
              medias: [{ stored_path: m1, mimetype: 'image/jpeg', kind: 'image', duration_seconds: null, waveform_json: null }],
            },
          ],
        },
      ],
      step_min_s: 1,
      step_max_s: 1,
      targets: tids.map((id) => ({ target_id: id, account_id: 1 })),
    }),
  });
  check('cria recorrente variavel com 3 opcoes', rec.status === 201, JSON.stringify(rec.body));

  const recDet = await api(`/schedules/${rec.body?.id}`);
  check('detalhe traz 3 opcoes', recDet.body?.options?.length === 3, `len=${recDet.body?.options?.length}`);
  check('opcao 2 tem 2 passos', recDet.body?.options?.[1]?.length === 2);
  check('variant_count gravado', recDet.body?.schedule?.variant_count === 3);
  check('variant_mode gravado', recDet.body?.schedule?.variant_mode === 'random');

  // --- varias opcoes em agendamento unico e erro ---
  const badOpts = await api('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'once',
      scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
      content_mode: 'broadcast',
      payload_type: 'text',
      options: [{ steps: [{ type: 'text', text: 'a' }] }, { steps: [{ type: 'text', text: 'b' }] }],
      targets: tids.map((id) => ({ target_id: id })),
    }),
  });
  check('recusa opcoes em agendamento unico', badOpts.status === 400, JSON.stringify(badOpts.body));

  // --- update: troca midias e nao quebra FK ---
  const upd = await api(`/schedules/${created.body?.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'keymaker editado',
      kind: 'once',
      scheduled_at: new Date(Date.now() + 7200_000).toISOString(),
      content_mode: 'broadcast',
      payload_type: 'sequence',
      steps: [
        { type: 'text', text: '{{Oi|Ola|Opa}} de novo' },
        {
          type: 'image',
          text: 'so uma agora',
          medias: [{ stored_path: m2, mimetype: 'image/jpeg', kind: 'image', duration_seconds: null, waveform_json: null }],
        },
      ],
      step_min_s: 1,
      step_max_s: 1,
      targets: tids.map((id) => ({ target_id: id, account_id: 1 })),
    }),
  });
  check('edita agendamento (FK dos passos ok)', upd.status === 200, JSON.stringify(upd.body));

  const det2 = await api(`/schedules/${created.body?.id}`);
  check('edicao deixou 1 midia no passo', det2.body?.steps?.[1]?.medias?.length === 1);

  // --- apagar nao estoura FK ---
  const del = await api(`/schedules/${created.body?.id}`, { method: 'DELETE' });
  check('apaga agendamento (FK dos passos ok)', del.status === 200, JSON.stringify(del.body));

  // --- automacao com spintax + 2 midias ---
  const rule = await api('/automation/rules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'boas-vindas',
      trigger_type: 'join',
      scope: ['1@g.us'],
      actions: [
        {
          type: 'group_message',
          steps: [
            { type: 'text', text: '{{Seja bem-vindo|Bem-vindo}}, {{primeiro_nome}}! {{saudacao}}.' },
            {
              type: 'image',
              text: 'Regras {{do grupo|da casa}}',
              medias: [
                { stored_path: m1, mimetype: 'image/jpeg', kind: 'image', duration_seconds: null, waveform_json: null },
                { stored_path: m2, mimetype: 'image/jpeg', kind: 'image', duration_seconds: null, waveform_json: null },
              ],
            },
          ],
          step_min_s: 1,
          step_max_s: 1,
        },
      ],
    }),
  });
  check('cria regra com spintax + 2 midias', rule.status === 201, JSON.stringify(rule.body));

  const rules = await api('/automation/rules');
  const act = rules.body?.rules?.[0]?.actions?.[0];
  check('regra guardou medias[]', act?.config?.steps?.[1]?.medias?.length === 2, JSON.stringify(act?.config?.steps?.[1]?.medias?.length));

  const badRule = await api('/automation/rules', {
    method: 'POST',
    body: JSON.stringify({
      name: 'ruim',
      trigger_type: 'join',
      scope: ['1@g.us'],
      actions: [{ type: 'group_message', steps: [{ type: 'text', text: 'oi {{a|b' }] }],
    }),
  });
  check('regra recusa bloco aberto', badRule.status === 400, JSON.stringify(badRule.body));
} finally {
  child.kill();
}

const falhas = results.filter((r) => !r.ok);
console.log(`\n${results.length - falhas.length}/${results.length} verificacoes OK`);
if (falhas.length) {
  console.log('FALHAS:', falhas.map((f) => f.name).join(' | '));
  process.exit(1);
}
