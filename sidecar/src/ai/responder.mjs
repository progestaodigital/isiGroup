// Liga a mensagem do grupo ao agente: avalia o gatilho, roda a triagem e
// envia a resposta.
//
// Tres travas que NAO sao opcionais aqui:
//
//  1. Anti-loop entre chips. O Baileys ja ignora a propria mensagem, mas no
//     multi-chip a resposta do chip A chega ao chip B como mensagem alheia e
//     dispararia o agente de novo — ping-pong infinito gastando API. Por isso
//     ignoramos remetentes que sejam contas NOSSAS.
//
//  2. Dedup por mensagem. N chips no mesmo grupo veem a mesma pergunta; ela
//     tem que gerar UMA resposta, nao N.
//
//  3. Cooldown por grupo. Limita a frequencia de respostas para que um grupo
//     agitado (ou alguem brincando) nao vire uma conta de centenas de reais.

import { runTriage } from './triage.mjs';
import { hasKey } from './openai.mjs';

const COOLDOWN_MS = 15000;      // intervalo minimo entre respostas no MESMO grupo
const MAX_PER_HOUR = 40;        // teto por grupo, por hora
const MAX_QUESTION_CHARS = 1500;
const DEDUP_TTL_MS = 10 * 60 * 1000;

export function createResponder(db, wa) {
  const lastAnswerAt = new Map(); // jid -> timestamp
  const hourly = new Map();       // jid -> { hora, n }
  const seen = new Map();         // chave -> timestamp (dedup multi-chip)

  function dedupe(key) {
    const now = Date.now();
    for (const [k, t] of seen) if (now - t > DEDUP_TTL_MS) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  }

  // O remetente e uma das NOSSAS contas? (anti-loop multi-chip)
  // Compara por id, jid e lid, porque o Baileys 7 identifica participante por
  // @lid e nao pelo telefone — ver o gotcha do @lid no CLAUDE.md.
  function isOwnAccount(sender) {
    if (!sender) return false;
    const base = String(sender).split('@')[0].split(':')[0];
    const rows = db.prepare('SELECT jid FROM accounts WHERE jid IS NOT NULL').all();
    return rows.some((r) => {
      const mine = String(r.jid).split('@')[0].split(':')[0];
      return mine && mine === base;
    });
  }

  // A mensagem menciona o chip que a recebeu (ou responde a uma dele)?
  function mentionsUs(info) {
    const ctx =
      info?.raw?.message?.extendedTextMessage?.contextInfo ??
      info?.raw?.message?.imageMessage?.contextInfo ??
      null;
    if (!ctx) return false;

    // Reply a uma mensagem nossa conta como mencao — e o fluxo natural de
    // continuar a conversa com o bot.
    if (ctx.participant && isOwnAccount(ctx.participant)) return true;

    const acct = db.prepare('SELECT jid FROM accounts WHERE id = ?').get(info.account_id);
    if (!acct?.jid) return false;
    const meu = String(acct.jid).split('@')[0].split(':')[0];
    return (ctx.mentionedJid ?? []).some((j) => String(j).split('@')[0].split(':')[0] === meu);
  }

  function matchesPattern(binding, text) {
    const pat = String(binding.pattern ?? '');
    if (!pat) return false;
    const t = binding.case_sensitive ? String(text) : String(text).toLowerCase();
    const p = binding.case_sensitive ? pat : pat.toLowerCase();
    switch (binding.match_type) {
      case 'starts_with': return t.trimStart().startsWith(p);
      case 'ends_with':   return t.trimEnd().endsWith(p);
      case 'exact':       return t.trim() === p.trim();
      default:            return t.includes(p);
    }
  }

  // O vinculo deve responder a esta mensagem?
  function triggered(binding, info) {
    switch (binding.trigger_mode) {
      case 'always': return true;
      case 'match':  return matchesPattern(binding, info.text);
      default:       return mentionsUs(info); // 'mention'
    }
  }

  // Remove a mencao do texto: "@5511999 qual o prazo?" -> "qual o prazo?".
  // Sem isso o numero entra no embedding e suja a busca.
  function cleanQuestion(text) {
    return String(text).replace(/@\d{6,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS);
  }

  // Chip que responde: o menor chip CONECTADO que e membro do grupo — mesma
  // regra da automacao, para o grupo ver sempre o mesmo numero respondendo.
  function responderFor(jid) {
    const rows = db
      .prepare('SELECT account_id FROM targets WHERE jid = ? AND account_id IS NOT NULL ORDER BY account_id')
      .all(jid);
    for (const r of rows) if (wa.isAccountConnected(r.account_id)) return r.account_id;
    return null;
  }

  function withinLimits(jid) {
    const now = Date.now();
    const last = lastAnswerAt.get(jid) ?? 0;
    if (now - last < COOLDOWN_MS) return { ok: false, why: 'cooldown' };

    const hora = Math.floor(now / 3600000);
    const h = hourly.get(jid);
    if (h?.hora === hora && h.n >= MAX_PER_HOUR) return { ok: false, why: 'limite_hora' };
    return { ok: true };
  }

  function countAnswer(jid) {
    const now = Date.now();
    lastAnswerAt.set(jid, now);
    const hora = Math.floor(now / 3600000);
    const h = hourly.get(jid);
    hourly.set(jid, h?.hora === hora ? { hora, n: h.n + 1 } : { hora, n: 1 });
  }

  function logEvent(row) {
    db.prepare(
      `INSERT INTO ai_answer_events
         (target_jid, account_id, binding_id, question, chosen_agent_id, route,
          tried_json, hops, answered, top_similarity, error, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.jid, row.account_id ?? null, row.binding_id ?? null, (row.question ?? '').slice(0, 1000),
      row.agent_id ?? null, row.route ?? null, JSON.stringify(row.tried ?? []),
      row.hops ?? 0, row.answered ? 1 : 0, row.top ?? null, row.error ?? null,
      new Date().toISOString()
    );
  }

  // Candidatos do vinculo: o agente fixo, ou todos os marcados para triagem.
  function candidatesFor(binding) {
    const rows =
      binding.mode === 'triage'
        ? db.prepare('SELECT * FROM ai_agents WHERE enabled = 1 AND use_in_triage = 1 ORDER BY id').all()
        : db.prepare('SELECT * FROM ai_agents WHERE id = ? AND enabled = 1').all(binding.agent_id);
    return rows.map((r) => ({ ...r, keywords: safeArr(r.keywords_json), enabled: !!r.enabled }));
  }

  /** Handler de mensagem de grupo. Chamado pelo whatsapp.mjs, em paralelo a automacao. */
  async function onMessage(info) {
    if (!info?.text || !info.jid?.endsWith('@g.us')) return;
    if (!hasKey()) return;                       // sem chave configurada, nem tenta
    if (isOwnAccount(info.sender)) return;       // trava 1: anti-loop entre chips

    const bindings = db
      .prepare('SELECT * FROM ai_group_bindings WHERE target_jid = ? AND enabled = 1 ORDER BY id')
      .all(info.jid);
    if (bindings.length === 0) return;

    const binding = bindings.find((b) => triggered(b, info));
    if (!binding) return;

    // trava 2: uma resposta por mensagem, mesmo com N chips no grupo
    if (!dedupe(`ai:${info.jid}:${info.msg_id}`)) return;

    // trava 3: cooldown / teto por hora
    const lim = withinLimits(info.jid);
    if (!lim.ok) {
      console.error(`[ai] ${info.jid}: ignorado (${lim.why})`);
      return;
    }

    const question = cleanQuestion(info.text);
    if (question.length < 3) return;

    const acct = responderFor(info.jid);
    if (!acct) {
      console.error(`[ai] ${info.jid}: nenhum chip conectado para responder`);
      return;
    }

    const candidates = candidatesFor(binding);
    if (candidates.length === 0) {
      logEvent({ jid: info.jid, account_id: acct, binding_id: binding.id, question, answered: false, error: 'sem agente disponivel' });
      return;
    }

    let r;
    try {
      r = await runTriage(db, question, candidates, { maxHops: binding.max_hops ?? 2 });
    } catch (e) {
      logEvent({ jid: info.jid, account_id: acct, binding_id: binding.id, question, answered: false, error: e?.message ?? 'erro' });
      return;
    }

    logEvent({
      jid: info.jid, account_id: acct, binding_id: binding.id, question,
      agent_id: r.agent?.id ?? null, route: r.route, tried: r.tried,
      hops: r.hops, answered: r.answered, top: r.topSimilarity, error: r.error ?? null,
    });

    // Nao soube: fica calado. Responder "nao sei" em grupo e ruido — o log
    // registra a lacuna para o usuario melhorar a base de conhecimento.
    if (!r.answered) {
      console.error(`[ai] ${info.jid}: sem resposta (${r.reason}, ${r.tried?.length ?? 0} agente(s) tentado(s))`);
      return;
    }

    try {
      await wa.accountSend(acct, info.jid, { text: r.answer });
      countAnswer(info.jid);
      console.error(`[ai] ${info.jid}: respondido por "${r.agent.name}" [chip ${acct}] (${r.route}, ${r.hops} salto(s))`);
    } catch (e) {
      console.error(`[ai] ${info.jid}: falha ao enviar: ${e?.message}`);
    }
  }

  // `_internals` existe para teste: o cooldown e checado antes do teto por
  // hora, entao so da para exercitar o teto manipulando o estado direto.
  return {
    onMessage,
    _internals: {
      mentionsUs, matchesPattern, cleanQuestion, isOwnAccount,
      withinLimits, countAnswer, lastAnswerAt, hourly, seen, dedupe,
    },
  };
}

function safeArr(s) {
  try {
    const v = JSON.parse(s ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
