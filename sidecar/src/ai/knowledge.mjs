// Base de conhecimento (RAG): extracao -> chunking -> embeddings -> busca.
//
// Parametros de chunking herdados do isiFlow, que ja os tem calibrados em
// producao: 1800 caracteres por pedaco com 200 de sobreposicao. A sobreposicao
// existe para nao cortar uma frase-chave exatamente na fronteira de dois
// pedacos e perde-la na busca.
//
// A busca e forca bruta (cosseno contra TODOS os chunks do agente). Sem indice
// aproximado porque o node:sqlite nao carrega extensao nativa — ver 018.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { embed, embedOne, dot, vecToBlob, blobToVec, EMBED_BATCH, EMBED_DIMS } from './openai.mjs';
import { safeFetchText, assertInsideUploads } from './net-guard.mjs';

export const MAX_CHUNK_CHARS = 1800;
export const CHUNK_OVERLAP_CHARS = 200;
export const MAX_CHUNKS_PER_DOC = 300; // teto anti-runaway (e anti-conta-salgada)
const MAX_DOC_CHARS = 600_000;

// --- Extracao de texto por tipo de fonte ---

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log']);

// Arquivo do disco -> texto puro. .txt/.md leem direto; .pdf e .docx passam
// por extrator. Formato desconhecido vira erro explicito em vez de lixo.
// `path` DEVE estar dentro da pasta de uploads do app — caminho arbitrario
// vindo do cliente leria qualquer arquivo do disco, e o conteudo volta pelas
// respostas do agente. O front envia os bytes por /ai/upload; e de la que sai.
export async function extractFromFile(rawPath) {
  const path = assertInsideUploads(rawPath);
  const ext = extname(path).toLowerCase();
  if (TEXT_EXT.has(ext)) return readFileSync(path, 'utf8');

  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: readFileSync(path) });
    try {
      const r = await parser.getText();
      return r?.text ?? '';
    } finally {
      await parser.destroy?.().catch?.(() => {});
    }
  }

  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default ?? (await import('mammoth'));
    const r = await mammoth.extractRawText({ path });
    return r?.value ?? '';
  }

  if (ext === '.doc') {
    throw new Error('.doc antigo nao e suportado — salve como .docx ou .pdf');
  }
  throw new Error(`formato nao suportado: ${ext || 'sem extensao'} (use .txt, .md, .pdf ou .docx)`);
}

// URL -> texto. Sem lib: remove script/style, converte tags em quebras e
// desescapa as entidades mais comuns. Suficiente para pagina de documentacao.
export async function extractFromUrl(url) {
  const { text, contentType } = await safeFetchText(url);
  if (!/html|xml/i.test(contentType)) return text; // ja e texto puro
  return htmlToText(text);
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// --- Chunking ---

// Empacota paragrafos em pedacos de ate MAX_CHUNK_CHARS, com sobreposicao.
// Quebrar por paragrafo (e nao por caractere cru) mantem a unidade semantica:
// um pedaco tende a conter a resposta inteira, nao meia frase.
export function chunkText(text) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_DOC_CHARS);
  if (!clean) return [];

  const chunks = [];
  let buf = '';
  for (const paraRaw of clean.split(/\n\s*\n/)) {
    const para = paraRaw.trim();
    if (!para) continue;

    // Paragrafo maior que um pedaco inteiro: fatia em janelas com sobreposicao.
    const pieces = [];
    if (para.length > MAX_CHUNK_CHARS) {
      for (let i = 0; i < para.length; i += MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS) {
        pieces.push(para.slice(i, i + MAX_CHUNK_CHARS));
      }
    } else {
      pieces.push(para);
    }

    for (const piece of pieces) {
      if (buf && buf.length + piece.length + 2 > MAX_CHUNK_CHARS) {
        chunks.push(buf.trim());
        if (chunks.length >= MAX_CHUNKS_PER_DOC) return chunks;
        // A cauda do pedaco anterior abre o proximo (a sobreposicao).
        buf = buf.slice(-CHUNK_OVERLAP_CHARS) + '\n\n' + piece;
      } else {
        buf = buf ? `${buf}\n\n${piece}` : piece;
      }
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.slice(0, MAX_CHUNKS_PER_DOC);
}

// --- Indexacao ---

// Fatia o documento, gera os embeddings em lotes e grava. Substitui os chunks
// anteriores do documento (reprocessar e idempotente).
// Retorna { chunks } ou lanca — o chamador grava o status/erro no documento.
export async function indexDocument(db, documentId) {
  const doc = db.prepare('SELECT * FROM ai_documents WHERE id = ?').get(documentId);
  if (!doc) throw new Error('documento nao encontrado');

  const parts = chunkText(doc.content);
  if (parts.length === 0) throw new Error('documento vazio — nada a indexar');

  const now = new Date().toISOString();
  const vectors = [];
  for (let i = 0; i < parts.length; i += EMBED_BATCH) {
    vectors.push(...(await embed(parts.slice(i, i + EMBED_BATCH))));
  }

  db.exec('BEGIN;');
  try {
    db.prepare('DELETE FROM ai_chunks WHERE document_id = ?').run(documentId);
    const ins = db.prepare(
      'INSERT INTO ai_chunks (agent_id, document_id, ord, content, embedding, dims, created_at) VALUES (?,?,?,?,?,?,?)'
    );
    parts.forEach((content, i) => {
      ins.run(doc.agent_id, documentId, i, content, vecToBlob(vectors[i]), vectors[i].length, now);
    });
    db.prepare("UPDATE ai_documents SET status = 'ready', error_msg = NULL, chunk_count = ?, updated_at = ? WHERE id = ?")
      .run(parts.length, now, documentId);
    db.exec('COMMIT;');
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
  return { chunks: parts.length };
}

// --- Busca ---

// Top-k chunks do agente por cosseno. Le todos os chunks do agente e ordena em
// memoria: O(n) por pergunta, com n = pedacos do agente. Em 20 mil chunks de
// 1536 dims sao ~30 milhoes de multiplicacoes — dezenas de ms, aceitavel.
export function searchChunks(db, agentId, queryVec, { k = 6, minSimilarity = 0 } = {}) {
  const rows = db
    .prepare('SELECT id, document_id, content, embedding FROM ai_chunks WHERE agent_id = ? AND embedding IS NOT NULL')
    .all(agentId);

  const scored = [];
  for (const r of rows) {
    const score = dot(queryVec, blobToVec(r.embedding)); // ambos normalizados
    if (score >= minSimilarity) scored.push({ id: r.id, document_id: r.document_id, content: r.content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// Busca a partir do texto da pergunta (gera o embedding dela).
export async function searchByQuestion(db, agentId, question, opts) {
  const vec = await embedOne(question);
  return searchChunks(db, agentId, vec, opts);
}

export { EMBED_DIMS };
