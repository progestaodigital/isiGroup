// Keymaker (Fase K): variacao de mensagem a partir de UM texto.
//
// Sintaxe: {{a|b|c}} sorteia uma das variacoes. Blocos aninham
// ({{oi {{amigo|parceiro}}|ola}}) e o numero de combinacoes e o produto dos
// blocos. Variavel de contexto e um bloco de nome reservado ({{grupo}}).
//
// Isto e variacao de copy (naturalidade, teste de mensagem) — nao existe aqui
// nada para evadir deteccao: sem caractere invisivel, sem homoglifo. O pacing
// anti-flood do scheduler continua sendo o unico mecanismo de ritmo.
//
// GARANTIAS DE COMPATIBILIDADE (o motor roda em cima de todo texto salvo):
//  1. Texto sem "{{" volta IDENTICO — caminho rapido, sem parse, sem unescape,
//     sem trim, sem colapso de espaco. Mensagem antiga sai byte a byte igual.
//  2. "{{...}}" so e bloco se tiver pipe OU for variavel reservada. Entao
//     "{{R$ 100}}" sai literal: chave acidental em texto legado (ou vinda de
//     plano/MCP) nunca e mastigada.
//  3. render() NUNCA lanca: template quebrado volta como foi escrito. Estrito
//     na porta (a rota recusa ao salvar), tolerante no disparo (o worker manda).

const MAX_LEN = 10_000; // tamanho maximo do template
const MAX_ALTS = 50; // variacoes por bloco
const MAX_DEPTH = 5; // aninhamento
const MAX_TOTAL = 1e12; // combinacoes (acima disso a aritmetica de indice perde exatidao)
const BUDGET = 500_000; // orcamento de trabalho do parser (guarda de entrada hostil)
const STACK_CAP = 200; // guarda de recursao, nao e regra de UX (MAX_DEPTH e a regra)
const NUL = '\u0000'; // sentinela interna: variavel que resolveu vazio

// Variaveis de contexto. Um bloco sem pipe cujo conteudo e um destes nomes
// resolve para o valor do contexto; qualquer outro bloco sem pipe sai literal.
export const VARIABLES = ['nome', 'primeiro_nome', 'grupo', 'chip', 'saudacao', 'data', 'hora'];
const VAR_SET = new Set(VARIABLES);

// Variaveis disponiveis por tipo de disparo. Broadcast em grupo nao tem uma
// pessoa, entao {{nome}} ali resolve vazio — a UI avisa ao salvar.
export const VARS_BROADCAST = ['grupo', 'chip', 'saudacao', 'data', 'hora'];
export const VARS_AUTOMATION = VARIABLES;

const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v == null ? '' : String(v));

// --- Parser -----------------------------------------------------------------
// No: {k:'lit'} | {k:'var'} | {k:'block', alts:[nodes]} | {k:'group', nodes}
// 'group' e um bloco sem pipe e sem variavel: sai literal (com as chaves),
// mas o conteudo segue sendo processado — {{oi {{a|b}}}} ainda varia por dentro.
//
// Duas guardas de custo, para que texto hostil ("{{" repetido 200x) nao vire
// backtracking exponencial: (a) posicao que JA falhou como inicio de bloco fica
// memoizada e nao e re-tentada, e (b) sem nenhum "}}" adiante o bloco e
// rejeitado em O(1). Fora isso, um orcamento de trabalho aborta o parse — quem
// chama trata como texto literal. Entrada normal nao chega perto do orcamento.

class TooComplex extends Error {}

function newState(src, diag) {
  return { src, diag, failed: new Set(), lastClose: src.lastIndexOf('}}'), work: 0 };
}

function parseSeq(st, i, depth, inBlock) {
  if (depth > STACK_CAP) throw new TooComplex('aninhamento profundo demais');
  const src = st.src;
  const nodes = [];
  let lit = '';
  const flush = () => {
    if (lit) nodes.push({ k: 'lit', v: lit });
    lit = '';
  };

  while (i < src.length) {
    if (++st.work > BUDGET) throw new TooComplex('texto complexo demais');
    const c = src[i];
    // Escape: \{ \} \| \\ viram o caractere literal.
    if (c === '\\' && i + 1 < src.length && '{}|\\'.includes(src[i + 1])) {
      lit += src[i + 1];
      i += 2;
      continue;
    }
    if (inBlock && c === '|') break;
    if (inBlock && c === '}' && src[i + 1] === '}') break;
    if (c === '{' && src[i + 1] === '{') {
      const blk = st.failed.has(i) ? null : scanBlock(st, i, depth);
      if (blk) {
        flush();
        nodes.push(blk.node);
        i = blk.end;
        continue;
      }
      // Nao fecha: as chaves sao literais (e validate acusa).
      st.failed.add(i);
      if (st.diag) st.diag.push({ level: 'error', msg: 'bloco {{ … }} sem fechamento' });
      lit += '{{';
      i += 2;
      continue;
    }
    lit += c === NUL ? '' : c; // sentinela interna nunca vem do usuario
    i++;
  }
  flush();
  return { nodes, end: i };
}

function scanBlock(st, i, depth) {
  const src = st.src;
  if (st.lastClose < i + 2) return null; // nao existe "}}" adiante: nem tenta
  let p = i + 2;
  const alts = [];
  for (;;) {
    const r = parseSeq(st, p, depth + 1, true);
    alts.push(r.nodes);
    p = r.end;
    if (src[p] === '|') {
      p++;
      continue;
    }
    if (src[p] === '}' && src[p + 1] === '}') {
      p += 2;
      break;
    }
    return null; // fim do texto sem fechar
  }

  const diag = st.diag;
  if (diag && depth + 1 > MAX_DEPTH) {
    diag.push({ level: 'error', msg: `aninhamento acima de ${MAX_DEPTH} niveis` });
  }

  if (alts.length === 1) {
    const name = soleName(alts[0]);
    if (name && VAR_SET.has(name)) return { node: { k: 'var', name }, end: p };
    if (diag) {
      diag.push({
        level: 'warn',
        msg: `"${src.slice(i, Math.min(p, i + 40))}" nao tem variacoes (nem e variavel): vai sair literal`,
      });
    }
    return { node: { k: 'group', nodes: alts[0] }, end: p };
  }
  if (diag && alts.length > MAX_ALTS) {
    diag.push({ level: 'error', msg: `bloco com ${alts.length} variacoes (maximo ${MAX_ALTS})` });
  }
  return { node: { k: 'block', alts }, end: p };
}

// Nome de variavel: o bloco tem exatamente um literal.
function soleName(nodes) {
  if (nodes.length !== 1 || nodes[0].k !== 'lit') return null;
  return nodes[0].v.trim().toLowerCase();
}

function parseTemplate(t, diag) {
  return parseSeq(newState(t, diag), 0, 0, false).nodes;
}

// --- Contagem ---------------------------------------------------------------
// Memoizada no proprio no: emitNodes consulta a contagem de cada no a cada
// envio, e sem memo uma arvore aninhada recontaria tudo a cada nivel.

function countNode(n) {
  if (n.c !== undefined) return n.c;
  let c = 1;
  if (n.k === 'block') {
    let s = 0;
    for (const alt of n.alts) s += countNodes(alt);
    c = Math.min(s, MAX_TOTAL);
  } else if (n.k === 'group') {
    c = countNodes(n.nodes);
  }
  n.c = c;
  return c;
}

function countNodes(nodes) {
  let p = 1;
  for (const n of nodes) {
    p *= countNode(n);
    if (p >= MAX_TOTAL) return MAX_TOTAL;
  }
  return p;
}

// Combinacoes de um texto. Sem spintax = 1.
export function countText(t) {
  if (typeof t !== 'string' || !t.includes('{{')) return 1;
  try {
    return countNodes(parseTemplate(t));
  } catch {
    return 1;
  }
}

// --- Render por indice ------------------------------------------------------
// Indice em radix misto: a combinacao numero N sai sem enumerar as outras, o
// que mantem o custo igual para 12 e para 10^12 combinacoes.

function emitNodes(nodes, index, ctx, out) {
  let k = index;
  const counts = nodes.map(countNode);
  const idxs = new Array(nodes.length);
  for (let j = 0; j < nodes.length; j++) {
    const c = counts[j];
    if (c > 1) {
      idxs[j] = k % c;
      k = Math.floor(k / c);
    } else {
      idxs[j] = 0;
    }
  }
  for (let j = 0; j < nodes.length; j++) emitNode(nodes[j], idxs[j], ctx, out);
}

function emitNode(n, index, ctx, out) {
  switch (n.k) {
    case 'lit':
      out.push(n.v);
      return;
    case 'var': {
      const v = varValue(n.name, ctx);
      out.push(v === '' ? NUL : v);
      return;
    }
    case 'group':
      out.push('{{');
      emitNodes(n.nodes, index, ctx, out);
      out.push('}}');
      return;
    case 'block': {
      let rest = index;
      for (const alt of n.alts) {
        const c = countNodes(alt);
        if (rest < c) return emitNodes(alt, rest, ctx, out);
        rest -= c;
      }
      // Indice fora de faixa (nao deve acontecer): primeira variacao.
      return emitNodes(n.alts[0], 0, ctx, out);
    }
    default:
      return;
  }
}

function varValue(name, ctx) {
  const now = ctx && ctx.now instanceof Date ? ctx.now : new Date();
  switch (name) {
    case 'nome':
      return str(ctx?.nome).trim();
    case 'primeiro_nome': {
      const parts = str(ctx?.nome).trim().split(/\s+/).filter(Boolean);
      return parts[0] ?? '';
    }
    case 'grupo':
      return str(ctx?.grupo).trim();
    case 'chip':
      return str(ctx?.chip).trim();
    case 'saudacao': {
      const h = now.getHours();
      return h < 12 ? 'bom dia' : h < 18 ? 'boa tarde' : 'boa noite';
    }
    case 'data':
      return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    case 'hora':
      return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    default:
      return '';
  }
}

// Variavel vazia come UM espaco vizinho: "Ola {{nome}}, tudo bem" sem nome
// sairia como "Ola , tudo bem".
const EMPTY_VAR_RE = new RegExp(` ?${NUL} ?`, 'g');
function cleanup(s) {
  if (!s.includes(NUL)) return s;
  return s.replace(EMPTY_VAR_RE, (m) => (m.startsWith(' ') && m.endsWith(' ') ? ' ' : ''));
}

// Resolve o texto. `index` ausente = sorteia. NUNCA lanca: em qualquer falha
// devolve o texto original (o worker precisa mandar algo, nunca travar).
export function render(t, opts = {}) {
  if (typeof t !== 'string' || t === '' || !t.includes('{{')) return t; // caminho rapido
  try {
    const nodes = parseTemplate(t);
    const total = countNodes(nodes);
    if (!(total > 0)) return t;
    let index = Number.isInteger(opts.index) ? opts.index : Math.floor(Math.random() * total);
    index = ((index % total) + total) % total;
    const out = [];
    emitNodes(nodes, index, opts.ctx ?? {}, out);
    return cleanup(out.join(''));
  } catch {
    return t;
  }
}

// --- Validacao (porta de entrada: create/update, planos, MCP) ---------------
// `available` = variaveis validas no contexto (VARS_BROADCAST/VARS_AUTOMATION).

export function validate(t, opts = {}) {
  const errors = [];
  const warnings = [];
  if (typeof t !== 'string' || !t.includes('{{')) return { ok: true, total: 1, errors, warnings };
  if (t.length > MAX_LEN) errors.push(`texto com ${t.length} caracteres (maximo ${MAX_LEN})`);

  const diag = [];
  let nodes = [];
  try {
    nodes = parseTemplate(t, diag);
  } catch (e) {
    errors.push(`nao foi possivel interpretar o texto: ${e?.message ?? 'erro'}`);
    return { ok: false, total: 1, errors, warnings };
  }
  for (const d of diag) (d.level === 'error' ? errors : warnings).push(d.msg);

  const total = countNodes(nodes);
  if (total >= MAX_TOTAL) errors.push('combinacoes demais: reduza as variacoes');

  if (Array.isArray(opts.available)) {
    const ok = new Set(opts.available);
    for (const name of usedVariables(nodes)) {
      if (!ok.has(name)) warnings.push(`{{${name}}} nao existe neste tipo de disparo: vai sair vazio`);
    }
  }

  return { ok: errors.length === 0, total, errors: dedupe(errors), warnings: dedupe(warnings) };
}

function usedVariables(nodes, acc = new Set()) {
  for (const n of nodes) {
    if (n.k === 'var') acc.add(n.name);
    else if (n.k === 'group') usedVariables(n.nodes, acc);
    else if (n.k === 'block') for (const alt of n.alts) usedVariables(alt, acc);
  }
  return acc;
}

const dedupe = (a) => [...new Set(a)];

// Amostras distintas (preview da UI). Nunca lanca.
export function samples(t, n = 3, ctx = {}) {
  const total = countText(t);
  const d = createDeck(total);
  const out = [];
  const wanted = Math.max(1, Math.min(n, total));
  const seen = new Set();
  for (let k = 0; k < wanted * 6 && out.length < wanted; k++) {
    const s = render(t, { ctx, index: d.draw() });
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (out.length === 0) out.push(render(t, { ctx, index: 0 }));
  return out;
}

// --- Baralho: sorteio sem repetir -------------------------------------------
// Vive por EXECUCAO (um disparo). Esgotado, reembaralha — e a ultima usada
// entra como ja usada, para que a virada de ciclo nao repita em seguida.

// Acima deste teto o baralho NAO rastreia o que ja saiu: ele viveria na
// memoria da automacao entre eventos, e com 10^12 combinacoes o conjunto de
// usados cresceria um item por disparo. Nessa escala a chance de repetir e
// irrelevante, entao o sorteio puro resolve.
const DECK_MAX = 4096;

export function createDeck(total) {
  const n = Number.isFinite(total) && total > 1 ? Math.floor(total) : 1;
  const track = n <= DECK_MAX;
  let used = new Set();
  let last = -1;
  return {
    get size() {
      return n;
    },
    draw() {
      if (n <= 1) return 0;
      if (!track) {
        last = Math.floor(Math.random() * n);
        return last;
      }
      if (used.size >= n) {
        used = new Set();
        if (last >= 0) used.add(last);
      }
      for (let k = 0; k < 64; k++) {
        const i = Math.floor(Math.random() * n);
        if (!used.has(i)) {
          used.add(i);
          last = i;
          return i;
        }
      }
      for (let i = 0; i < n; i++) {
        if (!used.has(i)) {
          used.add(i);
          last = i;
          return i;
        }
      }
      used = new Set([last]);
      return last;
    },
  };
}

// Conjunto de baralhos por chave (passo + campo). Cada campo sorteia no seu
// proprio espaco de combinacoes, que e o que permite legenda e midia variarem
// de forma independente.
export function createDeckSet() {
  const decks = new Map();
  return (key, total) => {
    const n = Number.isFinite(total) && total > 1 ? Math.floor(total) : 1;
    let d = decks.get(key);
    if (!d || d.size !== n) {
      d = createDeck(n);
      decks.set(key, d);
    }
    return d.draw();
  };
}

// --- Rodizio persistido (recorrente variavel) -------------------------------
// Puro: recebe o estado gravado e devolve o proximo. `used` esvazia ao fechar
// o ciclo, mantendo a ultima para nao repetir na virada.

export function nextVariant(total, usedArr = [], last = null, mode = 'random') {
  const n = Number.isInteger(total) && total > 1 ? total : 1;
  if (n <= 1) return { index: 0, used: [0] };

  const lastOk = Number.isInteger(last) && last >= 0 && last < n ? last : null;
  if (mode === 'sequential') {
    const index = lastOk == null ? 0 : (lastOk + 1) % n;
    return { index, used: [index] };
  }

  let used = new Set(
    (Array.isArray(usedArr) ? usedArr : []).filter((x) => Number.isInteger(x) && x >= 0 && x < n)
  );
  if (used.size >= n) {
    used = new Set();
    if (lastOk != null) used.add(lastOk);
  }
  const free = [];
  for (let i = 0; i < n; i++) if (!used.has(i)) free.push(i);
  const index = free.length ? free[Math.floor(Math.random() * free.length)] : (lastOk ?? 0);
  used.add(index);
  return { index, used: [...used].sort((a, b) => a - b) };
}

// --- Conteudo Baileys -------------------------------------------------------
// Aplica a variacao nos campos de texto de um conteudo ja montado (text,
// caption, enquete). Chamado POR ENVIO, no scheduler e na automacao.
//
// `draw(key, total)` entrega o indice: e o chamador que dona os baralhos (e
// que devolve 0 na edicao free, onde o recurso e bloqueado mas o texto NUNCA
// pode sair com as chaves cruas).

export function applySpin(content, opts = {}) {
  if (!content || typeof content !== 'object') return content;
  const ctx = opts.ctx ?? {};
  const draw =
    typeof opts.draw === 'function' ? opts.draw : (_k, total) => Math.floor(Math.random() * total);
  const spin = (key, t) => {
    if (typeof t !== 'string' || !t.includes('{{')) return t;
    const total = countText(t);
    return render(t, { ctx, index: total > 1 ? draw(key, total) : 0 });
  };

  let out = content;
  if (typeof content.text === 'string' && content.text.includes('{{')) {
    out = { ...out, text: spin('text', content.text) };
  }
  if (typeof content.caption === 'string' && content.caption.includes('{{')) {
    out = { ...out, caption: spin('caption', content.caption) };
  }

  const poll = content.poll;
  if (poll && typeof poll === 'object') {
    const values = Array.isArray(poll.values) ? poll.values : [];
    const hasVar =
      (typeof poll.name === 'string' && poll.name.includes('{{')) ||
      values.some((v) => typeof v === 'string' && v.includes('{{'));
    if (hasVar) {
      const name = spin('poll.name', poll.name);
      // O WhatsApp exige opcoes distintas: re-sorteia; no limite, usa a
      // primeira variacao de cada e remove as repetidas.
      let rendered = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const cand = values.map((v, i) => spin(`poll.v${i}`, v));
        const keys = cand.map((s) => String(s).trim().toLowerCase());
        if (new Set(keys).size === keys.length) {
          rendered = cand;
          break;
        }
      }
      if (!rendered) {
        const seen = new Set();
        rendered = [];
        for (const v of values) {
          const first = typeof v === 'string' && v.includes('{{') ? render(v, { ctx, index: 0 }) : v;
          const key = String(first).trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          rendered.push(first);
        }
      }
      out = {
        ...out,
        poll: {
          ...poll,
          name,
          values: rendered,
          selectableCount: Math.min(poll.selectableCount ?? 1, Math.max(1, rendered.length)),
        },
      };
    }
  }
  return out;
}

// Ha variacao de fato neste texto? (contador da UI / validacao)
export function hasSpin(t) {
  return typeof t === 'string' && t.includes('{{') && countText(t) > 1;
}
