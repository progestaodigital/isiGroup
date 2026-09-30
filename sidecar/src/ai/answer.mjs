// Resposta ancorada no conhecimento (a metade "G" do RAG).
//
// Duas travas contra o agente inventar resposta:
//
//  1. Corte ANTES do modelo: se o melhor trecho nao alcanca o min_similarity
//     do agente, devolve "nao sei" sem chamar a API. Economiza dinheiro e, mais
//     importante, impede o modelo de responder de cabeca quando a base nao tem
//     o assunto — que e exatamente quando ele inventa.
//
//  2. Saida estruturada: o modelo responde {answered, answer}. Esse booleano e
//     o que a triagem usa para decidir se passa a bola ao proximo agente
//     (boomerang). Texto livre com "nao sei" seria fragil de detectar.

import { chat } from './openai.mjs';
import { searchByQuestion } from './knowledge.mjs';

const TOP_K = 6;
const MAX_CONTEXT_CHARS = 8000; // teto do contexto montado (~2k tokens)

// Regras que o agente NAO pode sobrescrever pelo system_prompt dele.
const GROUNDING = `
Responda EXCLUSIVAMENTE com base nos trechos de contexto fornecidos.
Se o contexto nao contiver a informacao necessaria, responda com answered=false.
Nunca invente dados, numeros, prazos, precos ou politicas que nao estejam no contexto.
Nao mencione "contexto", "trechos" nem "base de conhecimento" na resposta — fale direto com a pessoa.
Responda em portugues do Brasil, de forma curta e direta: isso vai para uma mensagem de WhatsApp.`.trim();

const SCHEMA_HINT = `
Devolva SOMENTE um JSON valido, sem cercas de codigo, no formato:
{"answered": true|false, "answer": "texto da resposta"}
answered=false quando o contexto nao responder a pergunta (nesse caso "answer" pode ser vazio).`.trim();

// Monta o bloco de contexto respeitando o teto de caracteres.
function buildContext(hits) {
  const parts = [];
  let total = 0;
  for (const h of hits) {
    const piece = `[trecho ${parts.length + 1}]\n${h.content}`;
    if (total + piece.length > MAX_CONTEXT_CHARS) break;
    parts.push(piece);
    total += piece.length;
  }
  return parts.join('\n\n');
}

// Tolera o modelo devolvendo com cercas de codigo apesar da instrucao.
function parseAnswer(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  try {
    const o = JSON.parse(s);
    return { answered: !!o.answered, answer: String(o.answer ?? '').trim() };
  } catch {
    // Sem JSON valido: trata o texto cru como resposta, desde que exista algo.
    // Melhor responder do que engolir a resposta por causa de formato.
    return s ? { answered: true, answer: s } : { answered: false, answer: '' };
  }
}

/**
 * Tenta responder com o conhecimento de UM agente.
 * Retorna { answered, answer, topScore, hits, reason, error }.
 * `reason` explica a recusa: below_threshold | no_knowledge | model_declined.
 */
export async function answerWith(db, agent, question, { history = [] } = {}) {
  let hits;
  try {
    hits = await searchByQuestion(db, agent.id, question, { k: TOP_K, minSimilarity: 0 });
  } catch (e) {
    return { answered: false, reason: 'error', error: e?.message ?? 'falha na busca', topScore: 0 };
  }

  if (hits.length === 0) {
    return { answered: false, reason: 'no_knowledge', topScore: 0, hits: [] };
  }

  const topScore = hits[0].score;
  const cut = Number.isFinite(agent.min_similarity) ? agent.min_similarity : 0.3;
  if (topScore < cut) {
    // Nem chama o modelo: a base nao tem o assunto.
    return { answered: false, reason: 'below_threshold', topScore, hits };
  }

  // So os trechos acima do corte entram no contexto.
  const usable = hits.filter((h) => h.score >= cut);
  const messages = [
    { role: 'system', content: [agent.system_prompt?.trim(), GROUNDING, SCHEMA_HINT].filter(Boolean).join('\n\n') },
    // Historico recente do grupo, quando houver (da contexto a perguntas curtas
    // do tipo "e o meu?"), sempre depois do system e antes da pergunta.
    ...history.map((h) => ({ role: 'user', content: h })),
    { role: 'user', content: `Contexto:\n\n${buildContext(usable)}\n\n---\n\nPergunta: ${question}` },
  ];

  let raw;
  try {
    raw = await chat(messages, {
      model: agent.model,
      temperature: 0.2,
      maxTokens: 700,
      responseFormat: { type: 'json_object' },
    });
  } catch (e) {
    return { answered: false, reason: 'error', error: e?.message ?? 'falha no modelo', topScore, hits };
  }

  const parsed = parseAnswer(raw);
  if (!parsed.answered || !parsed.answer) {
    return { answered: false, reason: 'model_declined', topScore, hits };
  }
  return { answered: true, answer: parsed.answer, topScore, hits };
}
