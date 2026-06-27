// Envio de webhook (acao de automacao). Assina o payload com HMAC-SHA256 usando
// o secret da acao, para o CRM validar a origem. Retry leve com backoff.

import { createHmac } from 'node:crypto';

export async function postWebhook(url, secret, payload, attempt = 1) {
  const bodyStr = JSON.stringify(payload);
  const sig = createHmac('sha256', secret ?? '').update(bodyStr).digest('hex');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-isi-signature': `sha256=${sig}`,
      },
      body: bodyStr,
    });
    if (!res.ok && attempt < 3) throw new Error(`HTTP ${res.status}`);
    return res.ok;
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
      return postWebhook(url, secret, payload, attempt + 1);
    }
    console.error(`[webhook] falha ao entregar em ${url}: ${e?.message}`);
    return false;
  }
}
