// Testes do Keymaker. Roda com o runner embutido do Node (22.5+, que o projeto
// ja exige por causa do node:sqlite) — zero dependencia nova:
//
//   cd sidecar && node --test src/spin.test.mjs
//
// O foco e o contrato de compatibilidade: mensagem SEM spintax tem de sair
// identica, mensagem COM spintax tem de variar, e mensagem MISTA tem de
// preservar a moldura fixa em TODAS as combinacoes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySpin,
  countText,
  createDeck,
  createDeckSet,
  nextVariant,
  render,
  samples,
  validate,
  VARS_BROADCAST,
  VARS_AUTOMATION,
} from './spin.mjs';

// Todas as combinacoes de um template (ordem de indice).
function allRenders(t, ctx = {}) {
  const total = countText(t);
  const out = [];
  for (let i = 0; i < total; i++) out.push(render(t, { ctx, index: i }));
  return out;
}

const FIXED_NOW = new Date(2026, 0, 5, 9, 30, 0); // 05/01/2026 09:30, segunda

// --------------------------------------------------------------------------
// 1. SEM SPINTAX: volta identico
// --------------------------------------------------------------------------

test('texto sem spintax volta identico (caminho rapido)', () => {
  const plain = [
    'Oi, tudo bem?',
    'Plano A | Plano B | Plano C',
    'Preco: R$ 1.999,00',
    'chave solta } e { outra',
    'texto com }} solto no meio',
    'caminho C:\\temp\\arquivo.jpg',
    'linha1\nlinha2\n\n   indentado com espacos',
    'emoji 🎉 acento ção cedilha ç',
    'barra invertida simples \\ fim',
    '',
  ];
  for (const t of plain) {
    assert.equal(render(t), t, `mudou: ${JSON.stringify(t)}`);
    assert.equal(countText(t), 1);
    assert.equal(validate(t).ok, true);
  }
});

test('escape sem bloco nenhum tambem fica intacto (regra do caminho rapido)', () => {
  // Sem "{{" de verdade no texto, nada e interpretado — inclusive escapes.
  const t = 'literal \\{\\{a\\|b\\}\\} aqui';
  assert.equal(render(t), t);
});

test('chaves sem pipe e sem variavel saem literais', () => {
  assert.equal(render('{{R$ 100}}'), '{{R$ 100}}');
  assert.equal(countText('{{R$ 100}}'), 1);
  assert.equal(render('total {{SOMA}} ok'), 'total {{SOMA}} ok');

  const v = validate('{{R$ 100}}');
  assert.equal(v.ok, true); // nao e erro: e aviso
  assert.equal(v.warnings.length, 1);
});

test('render nunca engole o texto quando o bloco nao fecha', () => {
  assert.equal(render('{{a|b'), '{{a|b');
  assert.equal(render('oi {{a|b e mais'), 'oi {{a|b e mais');
  assert.equal(render('{{'), '{{');
});

test('objeto/numero/null passam sem alteracao', () => {
  assert.equal(render(null), null);
  assert.equal(render(undefined), undefined);
  assert.equal(render(42), 42);
});

// --------------------------------------------------------------------------
// 2. COM SPINTAX
// --------------------------------------------------------------------------

test('conta e cobre as combinacoes do exemplo real', () => {
  const t =
    '{{oi, tudo bem?|ola, como vai?|opa, tudo bem com voce?}}\n\n' +
    '{{Fabio Aleixo aqui|fabio Aleixo falando|aqui e o fabio aleixo|Fabio Aleixo entrando em contato}}';
  assert.equal(countText(t), 12); // 3 x 4

  const all = allRenders(t);
  assert.equal(all.length, 12);
  assert.equal(new Set(all).size, 12, 'todas as 12 combinacoes sao distintas');
  for (const s of all) assert.ok(!s.includes('{{'), `vazou chave: ${s}`);
});

test('bloco simples sorteia dentro das variacoes', () => {
  const t = '{{oi|ola|opa}}';
  assert.equal(countText(t), 3);
  assert.deepEqual(allRenders(t), ['oi', 'ola', 'opa']);
  for (let k = 0; k < 50; k++) assert.ok(['oi', 'ola', 'opa'].includes(render(t)));
});

test('aninhamento multiplica certo', () => {
  const t = '{{oi {{amigo|parceiro}}|ola}}';
  assert.equal(countText(t), 3); // (1x2) + 1
  assert.deepEqual(new Set(allRenders(t)), new Set(['oi amigo', 'oi parceiro', 'ola']));
});

test('variacao vazia e permitida (as vezes nada)', () => {
  const t = 'bom dia{{ pessoal|}}';
  assert.equal(countText(t), 2);
  assert.deepEqual(new Set(allRenders(t)), new Set(['bom dia pessoal', 'bom dia']));
});

test('escapes funcionam dentro de texto que tem bloco', () => {
  const t = '{{x|y}} e \\{\\{literal\\}\\} com \\| pipe';
  assert.equal(render(t, { index: 0 }), 'x e {{literal}} com | pipe');
  assert.equal(render(t, { index: 1 }), 'y e {{literal}} com | pipe');
});

test('indice fora de faixa nao quebra (envolve)', () => {
  const t = '{{a|b|c}}';
  assert.equal(render(t, { index: 0 }), render(t, { index: 3 }));
  assert.equal(render(t, { index: -1 }), render(t, { index: 2 }));
});

// --- variaveis de contexto ---

test('variaveis de contexto resolvem', () => {
  const ctx = { nome: 'Fabio Aleixo', grupo: 'Turma A', chip: 'Chip 1', now: FIXED_NOW };
  assert.equal(render('{{grupo}}', { ctx }), 'Turma A');
  assert.equal(render('{{nome}}', { ctx }), 'Fabio Aleixo');
  assert.equal(render('{{primeiro_nome}}', { ctx }), 'Fabio');
  assert.equal(render('{{chip}}', { ctx }), 'Chip 1');
  assert.equal(render('{{saudacao}}', { ctx }), 'bom dia');
  assert.equal(render('{{data}}', { ctx }), '05/01/2026');
  assert.equal(render('{{hora}}', { ctx }), '09:30');
  assert.equal(countText('{{grupo}} {{nome}}'), 1); // variavel nao multiplica
});

test('saudacao segue o horario', () => {
  const at = (h) => render('{{saudacao}}', { ctx: { now: new Date(2026, 0, 5, h, 0) } });
  assert.equal(at(8), 'bom dia');
  assert.equal(at(13), 'boa tarde');
  assert.equal(at(21), 'boa noite');
});

test('variavel ausente sai vazia e come um espaco vizinho', () => {
  assert.equal(render('Ola {{nome}}, tudo bem?', { ctx: {} }), 'Ola, tudo bem?');
  assert.equal(render('Ola {{nome}} tudo bem?', { ctx: {} }), 'Ola tudo bem?');
  assert.equal(render('{{nome}} chegou', { ctx: {} }), 'chegou');
});

test('variavel e spintax se compoem nas duas direcoes', () => {
  const ctx = { nome: 'Ana Paula', grupo: 'Turma A', now: FIXED_NOW };
  const t = '{{Oi {{primeiro_nome}}|{{saudacao}}, {{primeiro_nome}}}}! Bem-vinda ao {{grupo}}.';
  assert.equal(countText(t), 2);
  assert.deepEqual(new Set(allRenders(t, ctx)), new Set([
    'Oi Ana! Bem-vinda ao Turma A.',
    'bom dia, Ana! Bem-vinda ao Turma A.',
  ]));
});

// --------------------------------------------------------------------------
// 3. MISTAS: parte fixa + parte variavel
// --------------------------------------------------------------------------

test('mensagem mista preserva a moldura fixa em TODAS as combinacoes', () => {
  const t = 'Ola! {{tudo bem?|como vai?}} Confira: https://exemplo.com';
  const all = allRenders(t);
  assert.equal(all.length, 2);
  for (const s of all) {
    assert.ok(s.startsWith('Ola! '), `prefixo perdido: ${s}`);
    assert.ok(s.endsWith(' Confira: https://exemplo.com'), `sufixo perdido: ${s}`);
  }
});

test('moldura fixa sobrevive a varios blocos, quebras de linha e emoji', () => {
  const t = '{{Oi|Ola}} 🎉\n\nPreco: R$ 97,00\n{{Vem|Corre}} ver: https://x.com\n-- fim --';
  const all = allRenders(t);
  assert.equal(all.length, 4);
  for (const s of all) {
    // Remove as partes variaveis e confere que o resto esta intacto.
    const frame = s
      .replace(/^(Oi|Ola)/, '<A>')
      .replace(/(Vem|Corre)(?= ver)/, '<B>');
    assert.equal(frame, '<A> 🎉\n\nPreco: R$ 97,00\n<B> ver: https://x.com\n-- fim --');
  }
});

test('@all dentro de variacao sobrevive (o scheduler resolve depois)', () => {
  const t = '{{@all pessoal|@all galera}}, aviso!';
  for (const s of allRenders(t)) assert.ok(s.startsWith('@all '), s);
});

test('texto misto: bloco no meio de URL nao quebra o resto', () => {
  const t = 'Link: https://exemplo.com/{{a|b}}?x=1';
  assert.deepEqual(new Set(allRenders(t)), new Set([
    'Link: https://exemplo.com/a?x=1',
    'Link: https://exemplo.com/b?x=1',
  ]));
});

// --------------------------------------------------------------------------
// 4. VALIDACAO (porta de entrada)
// --------------------------------------------------------------------------

test('bloco sem fechamento e erro ao salvar (mas literal no disparo)', () => {
  const v = validate('oi {{a|b');
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 1);
  assert.equal(render('oi {{a|b'), 'oi {{a|b'); // disparo tolerante
});

test('aninhamento fundo demais e erro', () => {
  const t = '{{a|{{b|{{c|{{d|{{e|{{f|g}}}}}}}}}}}}';
  assert.equal(validate(t).ok, false);
});

test('variacoes demais num bloco e erro', () => {
  const alts = Array.from({ length: 51 }, (_, i) => `v${i}`).join('|');
  assert.equal(validate(`{{${alts}}}`).ok, false);
});

test('texto gigante e erro', () => {
  const v = validate('a'.repeat(10_001) + '{{x|y}}');
  assert.equal(v.ok, false);
});

test('validacao avisa variavel indisponivel no contexto', () => {
  const broadcast = validate('Ola {{nome}}, bem-vindo!', { available: VARS_BROADCAST });
  assert.equal(broadcast.ok, true);
  assert.equal(broadcast.warnings.length, 1);

  const automacao = validate('Ola {{nome}}, bem-vindo!', { available: VARS_AUTOMATION });
  assert.equal(automacao.warnings.length, 0);
});

test('validacao reporta o total de combinacoes', () => {
  assert.equal(validate('{{a|b}} {{1|2|3}}').total, 6);
  assert.equal(validate('texto simples').total, 1);
});

test('samples devolve amostras distintas e nao estoura', () => {
  const s = samples('{{a|b|c}} fixo', 3);
  assert.equal(s.length, 3);
  assert.equal(new Set(s).size, 3);
  assert.equal(samples('texto simples', 3).length, 1); // 1 combinacao: 1 amostra
});

// --------------------------------------------------------------------------
// 5. BARALHO (sem repetir) E RODIZIO PERSISTIDO
// --------------------------------------------------------------------------

test('baralho cobre todas as combinacoes antes de repetir', () => {
  const d = createDeck(4);
  const first = [d.draw(), d.draw(), d.draw(), d.draw()];
  assert.deepEqual(new Set(first), new Set([0, 1, 2, 3]));
  const next = d.draw();
  assert.notEqual(next, first[3], 'virada de ciclo nao pode repetir a ultima');
});

test('baralho de uma combinacao so devolve sempre 0 (passo sem spintax)', () => {
  const d = createDeck(1);
  for (let k = 0; k < 20; k++) assert.equal(d.draw(), 0);
  const d0 = createDeck(0);
  assert.equal(d0.draw(), 0);
});

test('conjunto de baralhos sorteia cada campo no seu proprio espaco', () => {
  const draw = createDeckSet();
  const a = [draw('passo0:text', 2), draw('passo0:text', 2)];
  assert.deepEqual(new Set(a), new Set([0, 1]));
  assert.equal(draw('passo1:midia', 1), 0); // espaco de 1: sempre 0
});

test('rodizio persistido nao repete em sequencia e cobre as opcoes', () => {
  const total = 5;
  let used = [];
  let last = null;
  const seen = new Set();
  for (let k = 0; k < 20; k++) {
    const r = nextVariant(total, used, last);
    assert.notEqual(r.index, last, 'disparo seguinte tem de ser uma opcao diferente');
    assert.ok(r.index >= 0 && r.index < total);
    seen.add(r.index);
    used = r.used;
    last = r.index;
  }
  assert.equal(seen.size, total, 'todas as opcoes aparecem ao longo dos ciclos');
});

test('rodizio sequencial anda em ordem e da a volta', () => {
  const seq = [];
  let last = null;
  for (let k = 0; k < 6; k++) {
    const r = nextVariant(4, [], last, 'sequential');
    seq.push(r.index);
    last = r.index;
  }
  assert.deepEqual(seq, [0, 1, 2, 3, 0, 1]);
});

test('rodizio com uma opcao so devolve sempre 0', () => {
  for (const total of [0, 1, null, undefined]) {
    assert.equal(nextVariant(total, [], null).index, 0);
  }
});

test('rodizio sanea estado invalido (opcao apagada pelo usuario)', () => {
  // Opcoes cairam de 5 para 2: indices gravados saem de faixa.
  const r = nextVariant(2, [7, 9, -1], 7);
  assert.ok(r.index >= 0 && r.index < 2);
  for (const i of r.used) assert.ok(i >= 0 && i < 2);
});

// --------------------------------------------------------------------------
// 6. CONTEUDO BAILEYS (applySpin)
// --------------------------------------------------------------------------

test('conteudo sem spintax volta o MESMO objeto (sem copia)', () => {
  const c = { text: 'mensagem simples' };
  assert.equal(applySpin(c), c);
  const img = { image: Buffer.from('x'), caption: 'legenda fixa' };
  assert.equal(applySpin(img), img);
});

test('applySpin varia texto e legenda, preservando o resto do conteudo', () => {
  const buf = Buffer.from('bytes');
  const out = applySpin(
    { image: buf, caption: 'Promo {{de hoje|da semana}}' },
    { draw: () => 0 }
  );
  assert.equal(out.caption, 'Promo de hoje');
  assert.equal(out.image, buf, 'a midia nao pode ser tocada');
});

test('applySpin usa uma chave de baralho por campo', () => {
  const keys = [];
  applySpin(
    { text: '{{a|b}}', caption: '{{c|d}}' },
    { draw: (k) => { keys.push(k); return 0; } }
  );
  assert.deepEqual(keys, ['text', 'caption']);
});

test('applySpin respeita o indice 0 (edicao free) sem vazar chaves', () => {
  const out = applySpin({ text: '{{primeira|segunda|terceira}}' }, { draw: () => 0 });
  assert.equal(out.text, 'primeira');
  assert.ok(!out.text.includes('{{'));
});

test('enquete: opcoes resultantes sao sempre distintas', () => {
  for (let k = 0; k < 40; k++) {
    const out = applySpin({
      poll: { name: 'Qual {{prefere|escolhe}}?', values: ['{{A|B}}', '{{A|B}}', 'C'], selectableCount: 1 },
    });
    const vals = out.poll.values.map((v) => String(v).trim().toLowerCase());
    assert.equal(new Set(vals).size, vals.length, `repetiu: ${JSON.stringify(out.poll.values)}`);
    assert.ok(vals.length >= 1);
    assert.ok(out.poll.selectableCount <= out.poll.values.length);
    assert.ok(!out.poll.name.includes('{{'));
  }
});

test('enquete sem spintax nao e tocada', () => {
  const poll = { name: 'Vem?', values: ['Sim', 'Nao'], selectableCount: 1 };
  const c = { poll };
  assert.equal(applySpin(c), c);
});

// --------------------------------------------------------------------------
// 7. ROBUSTEZ: render nunca lanca
// --------------------------------------------------------------------------

test('entradas hostis nao lancam e nunca vazam chave crua quando ha bloco valido', () => {
  const hostis = [
    '{{',
    '}}',
    '{{{{',
    '}}}}',
    '{{|}}',
    '{{||}}',
    '{{a|{{}}',
    '{{a|b}}{{c|d}}{{e|f}}',
    '{{'.repeat(200) + 'x',
    '{{a|b}}'.repeat(300),
    '\\',
    '\\\\{{a|b}}',
  ];
  for (const t of hostis) {
    assert.doesNotThrow(() => render(t), `lancou em ${JSON.stringify(t)}`);
    assert.doesNotThrow(() => countText(t));
    assert.doesNotThrow(() => validate(t));
    assert.equal(typeof render(t), 'string');
  }
});

test('combinacoes absurdas sao barradas na validacao, nao no disparo', () => {
  const t = '{{a|b|c|d|e|f|g|h|i|j}}'.repeat(13); // 10^13
  const v = validate(t);
  assert.equal(v.ok, false);
  assert.doesNotThrow(() => render(t));
});
