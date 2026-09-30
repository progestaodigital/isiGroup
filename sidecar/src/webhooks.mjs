// Envio de webhook (acao de automacao). Ponto UNICO de saida: vale para todos
// os gatilhos (entrou / saiu / mensagem / link).
//
// Autenticacao — dois mecanismos, com papeis diferentes:
//
//  * `x-api-key` e `Authorization: Bearer` levam a credencial CRUA, exatamente
//    como o usuario colou (sem trim, sem encode). Esta e a autenticacao
//    PRINCIPAL: e o que isiFlow, n8n, Make, Zapier e endpoints proprios
//    procuram. Antes o app so mandava a assinatura, e como ninguem conhece o
//    header proprietario, a chave nunca era lida — o receptor recusava com
//    "Invalid API key" mesmo com a chave certa configurada dos dois lados.
//
//  * `x-isi-signature` continua indo como assinatura COMPLEMENTAR (opcional):
//    HMAC-SHA256 do corpo bruto, no formato `sha256=<hex>`. Serve a quem quer
//    provar que o corpo nao foi adulterado em transito — algo que a chave
//    sozinha nao garante. Quem ja validava por ela continua funcionando.

import { createHmac } from 'node:crypto';

const MAX_ATTEMPTS = 3;

// Headers exatos de uma entrega. Fonte unica — postWebhook usa esta funcao,
// entao o teste cobre o que sai de verdade na rede.
export function buildWebhookHeaders(secret, bodyStr) {
  const headers = {
    'content-type': 'application/json',
    // Assinatura sobre o corpo BRUTO — o receptor precisa calcular sobre os
    // mesmos bytes que chegaram, nao sobre o JSON re-serializado.
    'x-isi-signature': `sha256=${createHmac('sha256', secret ?? '').update(bodyStr).digest('hex')}`,
  };
  // Valor CRU, sem trim nem encode: qualquer transformacao aqui quebraria a
  // comparacao byte a byte que o receptor faz.
  if (secret) {
    headers['x-api-key'] = secret;
    headers.authorization = `Bearer ${secret}`;
  }
  return headers;
}

export async function postWebhook(url, secret, payload) {
  const bodyStr = JSON.stringify(payload);
  // Montados UMA vez e reusados em toda re-tentativa: uma falha transitoria
  // nao pode fazer o retry sair sem credencial.
  const headers = buildWebhookHeaders(secret, bodyStr);

  let ultimoErro = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: bodyStr });
      if (res.ok) return true;
      ultimoErro = `HTTP ${res.status}`;
    } catch (e) {
      ultimoErro = e?.message ?? String(e);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
  }

  console.error(`[webhook] falha ao entregar em ${url}: ${ultimoErro}`);
  return false;
}
