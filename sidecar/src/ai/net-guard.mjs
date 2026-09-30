// Guardas de rede e de disco para a ingestao de conhecimento.
//
// Por que existe: as duas fontes "externas" (URL e arquivo) recebem um alvo
// escolhido pelo chamador, e o conteudo ingerido volta legivel pelas respostas
// do agente e pela busca de teste. Sem guarda, as duas viram exfiltracao:
//   * URL  -> SSRF: buscar http://127.0.0.1:porta, painel do roteador, intranet.
//   * File -> ler id_rsa, o proprio isigroup.db, qualquer coisa do disco.
//
// O token de sessao NAO basta como protecao: a ponte MCP existe para uma IA
// externa operar o app, e planos isiplan vem de fora.

import { lookup } from 'node:dns/promises';
import { realpathSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 30000;
const MAX_BYTES = 5 * 1024 * 1024; // pagina de documentacao nao passa disso

// --- Faixas de IP bloqueadas ---

const v4Blocked = [
  [[0, 0, 0, 0], 8],        // "this network"
  [[10, 0, 0, 0], 8],       // privada
  [[100, 64, 0, 0], 10],    // CGNAT
  [[127, 0, 0, 0], 8],      // loopback
  [[169, 254, 0, 0], 16],   // link-local
  [[172, 16, 0, 0], 12],    // privada
  [[192, 0, 0, 0], 24],     // IETF protocol assignments
  [[192, 168, 0, 0], 16],   // privada
  [[198, 18, 0, 0], 15],    // benchmarking
  [[224, 0, 0, 0], 4],      // multicast
  [[240, 0, 0, 0], 4],      // reservado (inclui 255.255.255.255)
];

const inV4Range = (octets, [base, bits]) => {
  const toInt = (o) => ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(octets) & mask) === (toInt(base) & mask);
};

// Expande um IPv6 para os 8 grupos numericos. Resolve "::", zona (%eth0) e a
// forma com IPv4 embutido. Devolve null se nao for IPv6 valido.
//
// Existe porque casar TEXTO de IPv6 nao funciona: o mesmo endereco tem varias
// grafias. O parser de URL do Node, por exemplo, reescreve
// [::ffff:127.0.0.1] como [::ffff:7f00:1] — hexadecimal. Uma guarda que so
// procurasse "::ffff:" seguido de pontos deixaria loopback passar.
function expandIPv6(addr) {
  let a = addr.split('%')[0];

  // IPv4 embutido no fim (::ffff:1.2.3.4) -> converte para 2 grupos hex.
  const emb = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a);
  if (emb) {
    const o = emb[2].split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    a = `${emb[1]}${(((o[0] << 8) | o[1]) >>> 0).toString(16)}:${(((o[2] << 8) | o[3]) >>> 0).toString(16)}`;
  }

  const lados = a.split('::');
  if (lados.length > 2) return null;
  const head = lados[0] ? lados[0].split(':') : [];
  const rear = lados.length === 2 ? (lados[1] ? lados[1].split(':') : []) : [];
  const preenche = 8 - head.length - rear.length;
  if (lados.length === 1 ? head.length !== 8 : preenche < 0) return null;

  const grupos = [...head, ...Array(lados.length === 2 ? preenche : 0).fill('0'), ...rear];
  if (grupos.length !== 8) return null;
  const nums = grupos.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

export function isBlockedIp(ip) {
  if (!ip) return true;
  // Colchetes (do parser de URL) e zona saem antes de qualquer analise.
  const addr = String(ip).toLowerCase().trim().replace(/^\[|\]$/g, '').split('%')[0];

  // IPv4 em notacao pontilhada.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (m) {
    const oct = m.slice(1).map(Number);
    if (oct.some((o) => o > 255)) return true;
    return v4Blocked.some((r) => inV4Range(oct, r));
  }

  const g = expandIPv6(addr);
  if (!g) return true; // nao entendi o formato -> recusa (falha fechada)

  const zerosAte = (n) => g.slice(0, n).every((x) => x === 0);

  // IPv4 mapeado (::ffff:a.b.c.d) e IPv4-compativel (::a.b.c.d): valem as
  // regras de IPv4 sobre os 32 bits finais. E por aqui que loopback se
  // disfarcava de IPv6.
  const ehMapeado = zerosAte(5) && g[5] === 0xffff;
  const ehCompativel = zerosAte(6) && (g[6] !== 0 || g[7] !== 0);
  if (ehMapeado || ehCompativel) {
    const oct = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
    return v4Blocked.some((r) => inV4Range(oct, r));
  }

  if (g.every((x) => x === 0)) return true;              // ::   nao especificado
  if (zerosAte(7) && g[7] === 1) return true;            // ::1  loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true;           // fc00::/7  unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true;           // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true;           // ff00::/8  multicast
  return false;
}

// Resolve o host e recusa se QUALQUER endereco cair em faixa bloqueada.
// Checar todos evita o caso de um host com registro publico e privado ao mesmo
// tempo (nao fecha a janela de DNS rebinding, mas fecha o caso trivial).
export async function assertPublicHost(hostname) {
  // IP literal na URL: valida direto, sem DNS.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    if (isBlockedIp(hostname)) throw new Error('endereco de rede interna nao e permitido');
    return;
  }
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`nao foi possivel resolver o endereco "${hostname}"`);
  }
  if (!addrs.length) throw new Error(`nao foi possivel resolver o endereco "${hostname}"`);
  if (addrs.some((a) => isBlockedIp(a.address))) {
    throw new Error('este endereco aponta para a rede interna e nao pode ser lido');
  }
}

// Busca uma URL publica seguindo redirecionamentos MANUALMENTE, revalidando o
// destino a cada salto. Sem isso, uma URL publica redirecionaria para
// 127.0.0.1 e o guard do primeiro salto nao valeria de nada.
export async function safeFetchText(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL invalida');
  }

  for (let hop = 0; ; hop++) {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('somente http e https sao aceitos');
    }
    await assertPublicHost(url.hostname);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'manual', // nos seguimos, revalidando cada destino
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; isigroup)' },
      });
    } catch (e) {
      clearTimeout(timer);
      throw e?.name === 'AbortError' ? new Error('a pagina demorou demais para responder') : e;
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(timer);
      if (hop >= MAX_REDIRECTS) throw new Error('redirecionamentos demais');
      url = new URL(res.headers.get('location'), url); // relativo tambem resolve
      continue;
    }

    try {
      if (!res.ok) throw new Error(`a pagina respondeu HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) throw new Error('pagina grande demais');
      const text = await readCapped(res, MAX_BYTES);
      return { text, contentType: res.headers.get('content-type') ?? '' };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Le o corpo com teto de bytes (content-length pode faltar ou mentir).
async function readCapped(res, max) {
  if (!res.body) return await res.text();
  const chunks = [];
  let total = 0;
  for await (const c of res.body) {
    total += c.length;
    if (total > max) throw new Error('pagina grande demais');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// --- Sandbox de arquivos ---

// Arquivos de conhecimento so podem ser lidos de UM diretorio controlado, no
// qual o proprio app escreve (via /ai/upload). Caminho arbitrario vindo do
// cliente le qualquer coisa do disco — e o conteudo volta pelas respostas.
let uploadsDir = null;

export function setUploadsDir(dir) {
  mkdirSync(dir, { recursive: true });
  uploadsDir = realpathSync(dir);
  return uploadsDir;
}

export const getUploadsDir = () => uploadsDir;

// Devolve o caminho real se estiver DENTRO do sandbox; lanca caso contrario.
// Usa realpath nos dois lados: resolve "..", links simbolicos e juncoes do
// Windows, entao nao da para escapar por atalho.
export function assertInsideUploads(path) {
  if (!uploadsDir) throw new Error('diretorio de uploads nao inicializado');
  let real;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new Error('arquivo nao encontrado');
  }
  if (real !== uploadsDir && !real.startsWith(uploadsDir + sep)) {
    throw new Error('este arquivo esta fora da pasta de uploads do isigroup');
  }
  return real;
}
