// Triagem: escolhe QUAL agente responde, e insiste no proximo se o primeiro
// nao souber (o "boomerang" do isiFlow).
//
// Duas etapas, nessa ordem, por economia:
//
//  1. Atalho por palavra-chave — deterministico e de graca. Se a pergunta
//     contem uma keyword de um unico agente, vai direto nele. Cobre o caso
//     obvio ("boleto") sem gastar uma chamada de classificacao.
//
//  2. Classificacao pelo modelo — le a DESCRICAO de cada agente e escolhe.
//     A descricao e o sinal de roteamento: configurar a triagem e escrever
//     boas descricoes, nao fiar regra.
//
// O teto de saltos existe porque cada agente que erra custa 1 embedding + 1
// completion. Sem teto, uma pergunta fora do escopo varreria a base inteira
// na conta do usuario.

import { chat } from './openai.mjs';
import { answerWith } from './answer.mjs';

// Marcas de acento combinantes (U+0300..U+036F): removidas para que
// "duvida" case com "dúvida".
const DIACRITICOS = /[\u0300-\u036f]/g;

// Palavra-chave casa em limite de palavra: "boleto" casa em "meu boleto
// venceu", mas "2a via" nao casa dentro de outra palavra por acidente.
function keywordHit(question, keywords) {
  const q = ` ${String(question).toLowerCase().normalize('NFD').replace(DIACRITICOS, '')} `;
  return keywords.some((k) => {
    const kk = String(k).toLowerCase().normalize('NFD').replace(DIACRITICOS, '').trim();
    if (!kk) return false;
    return new RegExp(`(^|[^a-z0-9])${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(q);
  });
}

/**
 * Ordena os candidatos por probabilidade de responder.
 * Retorna { order: agent[], route: 'keyword'|'llm'|'single' }.
 * A ordem importa: e ela que o boomerang percorre.
 */
export async function rankAgents(question, candidates) {
  if (candidates.length === 0) return { order: [], route: 'single' };
  if (candidates.length === 1) return { order: candidates, route: 'single' };

  // 1) Atalho deterministico — so vale se UM agente casar. Dois casando e
  //    ambiguo, e ai o modelo decide melhor que a ordem alfabetica.
  const hits = candidates.filter((a) => keywordHit(question, a.keywords ?? []));
  if (hits.length === 1) {
    const rest = candidates.filter((a) => a.id !== hits[0].id);
    return { order: [hits[0], ...rest], route: 'keyword' };
  }

  // 2) Classificacao pelo modelo. Pede a ORDEM completa, nao so o primeiro —
  //    assim o boomerang ja tem a fila pronta sem nova chamada a cada salto.
  const lista = candidates
    .map((a, i) => `${i + 1}. ${a.name} — ${a.description || '(sem descricao)'}`)
    .join('\n');
  const messages = [
    {
      role: 'system',
      content:
        'Voce roteia perguntas para especialistas. Leia a descricao de cada um e ordene do mais ao menos ' +
        'provavel de saber responder. Devolva SOMENTE um JSON: {"ordem": [numeros]} com todos os numeros da lista.',
    },
    { role: 'user', content: `Especialistas:\n${lista}\n\nPergunta: ${question}` },
  ];

  try {
    const raw = await chat(messages, { temperature: 0, maxTokens: 120, responseFormat: { type: 'json_object' } });
    const parsed = JSON.parse(String(raw).replace(/^```(?:json)?|```$/g, '').trim());
    const idx = Array.isArray(parsed?.ordem) ? parsed.ordem : [];
    const order = [];
    for (const n of idx) {
      const a = candidates[Number(n) - 1];
      if (a && !order.includes(a)) order.push(a);
    }
    // Quem o modelo esqueceu entra no fim (nunca perder candidato).
    for (const a of candidates) if (!order.includes(a)) order.push(a);
    return { order, route: 'llm' };
  } catch {
    // Classificacao falhou: segue na ordem natural em vez de nao responder.
    return { order: candidates, route: 'llm' };
  }
}

/**
 * Pergunta -> resposta, tentando os agentes em ordem ate alguem saber.
 *
 * Retorna { answered, answer, agent, tried[], hops, route, topSimilarity }.
 * `maxHops` conta TENTATIVAS EXTRAS: 0 = so o primeiro; 2 = ate 3 agentes.
 * `answerFn` e injetavel para teste: o laco do boomerang e a parte que mais
 * precisa de cobertura e a unica que nao depende da API.
 */
export async function runTriage(
  db, question, candidates,
  { maxHops = 2, history = [], answerFn = answerWith, rankFn = rankAgents } = {}
) {
  const usable = candidates.filter((a) => a.enabled);
  if (usable.length === 0) {
    return { answered: false, reason: 'no_agents', tried: [], hops: 0, route: 'single' };
  }

  const { order, route } = await rankFn(question, usable);
  const limite = Math.min(order.length, Math.max(1, maxHops + 1));

  const tried = [];
  let topSimilarity = 0;
  let lastReason = 'no_agents';

  for (let i = 0; i < limite; i++) {
    const agent = order[i];
    const r = await answerFn(db, agent, question, { history });
    tried.push({ agent_id: agent.id, name: agent.name, reason: r.reason ?? null, score: r.topScore ?? 0 });
    topSimilarity = Math.max(topSimilarity, r.topScore ?? 0);
    lastReason = r.reason ?? lastReason;

    if (r.answered) {
      return { answered: true, answer: r.answer, agent, tried, hops: i, route, topSimilarity };
    }
    // Erro de API (chave invalida, sem credito) nao melhora tentando outro
    // agente — a falha e da conta, nao do conhecimento. Para aqui.
    if (r.reason === 'error') {
      return { answered: false, reason: 'error', error: r.error, tried, hops: i, route, topSimilarity };
    }
  }

  return { answered: false, reason: lastReason, tried, hops: tried.length - 1, route, topSimilarity };
}

export { keywordHit };
