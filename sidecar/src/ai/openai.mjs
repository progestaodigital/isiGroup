// Cliente da OpenAI — embeddings e chat completions.
//
// A chave NAO e persistida aqui nem no SQLite: vive no keyring do OS e o front
// a injeta em memoria via POST /ai/key a cada arranque. Se o processo morre, a
// chave morre junto — e o front reinjeta.
//
// Erros da API sao traduzidos para mensagem util (chave invalida, sem credito,
// rate limit), porque quem le e o usuario final na tela, nao um dev.

const API = 'https://api.openai.com/v1';
export const EMBED_MODEL = 'text-embedding-3-small'; // 1536 dims
export const EMBED_DIMS = 1536;
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';

// Lote de embeddings por chamada. A API aceita mais, mas lotes grandes elevam
// a chance de estourar o limite de tokens do request inteiro.
export const EMBED_BATCH = 64;

const TIMEOUT_MS = 60000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

let apiKey = null; // so em memoria

export function setKey(key) {
  apiKey = typeof key === 'string' && key.trim() ? key.trim() : null;
  return hasKey();
}
export const hasKey = () => !!apiKey;
export const maskKey = () => (apiKey ? `sk-...${apiKey.slice(-4)}` : null);

class OpenAIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Mensagem que o usuario final consegue agir em cima.
function friendly(status, body) {
  const msg = body?.error?.message ?? '';
  if (status === 401) return 'chave da OpenAI invalida ou revogada — confira em Agentes de IA';
  if (status === 429 && /quota|billing/i.test(msg)) return 'sua conta da OpenAI esta sem credito';
  if (status === 429) return 'limite de requisicoes da OpenAI atingido — tente em instantes';
  if (status === 400 && /maximum context length/i.test(msg)) return 'texto longo demais para o modelo';
  return msg || `erro da OpenAI (HTTP ${status})`;
}

async function call(path, payload) {
  if (!apiKey) throw new OpenAIError('nenhuma chave da OpenAI configurada', 0);

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
      if (res.ok) return await res.json();

      const body = await res.json().catch(() => null);
      const err = new OpenAIError(friendly(res.status, body), res.status);
      // 401/400 nao melhoram com re-tentativa; 429/5xx sim.
      if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) throw err;
      lastErr = err;
    } catch (e) {
      if (e instanceof OpenAIError && !RETRY_STATUS.has(e.status)) throw e;
      if (attempt === MAX_ATTEMPTS) throw e?.name === 'AbortError' ? new OpenAIError('a OpenAI demorou demais para responder', 0) : e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    // Backoff exponencial simples com jitter (1s, 2s...).
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1) + Math.random() * 300));
  }
  throw lastErr;
}

// Embeddings de um lote de textos. Devolve Float32Array[] na ordem da entrada.
export async function embed(texts) {
  const input = texts.map((t) => String(t ?? '').slice(0, 8000));
  if (input.length === 0) return [];
  const json = await call('/embeddings', { model: EMBED_MODEL, input });
  // A API pode devolver fora de ordem; `index` e a autoridade.
  const out = new Array(input.length);
  for (const d of json.data ?? []) out[d.index] = normalize(Float32Array.from(d.embedding));
  if (out.some((v) => !v)) throw new OpenAIError('resposta de embeddings incompleta', 0);
  return out;
}

export const embedOne = async (text) => (await embed([text]))[0];

// Chat completion. `messages` no formato da API; devolve o texto da resposta.
export async function chat(messages, { model = DEFAULT_CHAT_MODEL, temperature = 0.2, maxTokens = 700, responseFormat } = {}) {
  const payload = { model, messages, temperature, max_tokens: maxTokens };
  if (responseFormat) payload.response_format = responseFormat;
  const json = await call('/chat/completions', payload);
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

// Valida a chave com a chamada mais barata possivel (1 embedding curto).
export async function validateKey() {
  try {
    await embed(['ok']);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e?.message ?? 'falha ao validar' };
  }
}

// --- Serializacao do vetor para o SQLite (BLOB) ---
// Float32Array <-> Buffer. Guardar como BLOB em vez de JSON corta ~4x o
// tamanho e evita parse a cada busca (a busca le TODOS os chunks do agente).

export const vecToBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

export function blobToVec(blob) {
  if (!blob) return null;
  // O node:sqlite devolve Uint8Array com byteOffset 0 (medido), entao da para
  // montar a view direto sobre o buffer — sem copia. Se algum dia vier
  // desalinhado, o fallback copia (Float32Array exige offset multiplo de 4).
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  const copy = Buffer.from(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// Normaliza para norma 1, in-place. Os vetores da OpenAI ja chegam assim, mas
// garantir na GRAVACAO permite usar produto escalar puro na busca — e a busca
// roda contra todos os chunks, entao e la que os ciclos importam.
export function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n);
  if (n > 0 && Math.abs(n - 1) > 1e-6) {
    for (let i = 0; i < vec.length; i++) vec[i] /= n;
  }
  return vec;
}

// Similaridade entre vetores JA normalizados: produto escalar.
// ~3x menos operacoes que recalcular as normas a cada comparacao.
export function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += a[i] * b[i];
  return acc;
}

// Cosseno completo — usado so onde a normalizacao nao e garantida (testes).
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}
