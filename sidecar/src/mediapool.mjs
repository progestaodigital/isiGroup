// Cache de arquivos de midia com ORCAMENTO DE BYTES (Fase K5).
//
// Antes, o scheduler lia a midia uma vez e reusava em todos os grupos — era
// sempre UM arquivo por passo. Com rodizio de N midias, pre-carregar tudo
// significaria somar os arquivos na RAM (o upload permite 64 MB cada: 10
// videos = 640 MB). Entao: leitura sob demanda, cache por caminho ate o
// orcamento, descartando o menos usado recentemente. Imagem fica toda em
// cache; video grande e relido do disco a cada envio — leitura local, e os
// envios sao espacados em segundos pelo pacing anti-flood.
//
// Arquivo ausente e memoizado como `null`: nao tenta reler a cada grupo, e
// quem chama trata (o scheduler re-sorteia entre as midias restantes).

import { readFileSync } from 'node:fs';

const DEFAULT_BUDGET = 128 * 1024 * 1024; // 128 MB

export function createMediaCache(budget = DEFAULT_BUDGET) {
  const cache = new Map(); // path -> Buffer | null
  let bytes = 0;

  return {
    // Buffer do arquivo, ou null se nao existe/nao pode ser lido.
    read(path) {
      if (!path) return null;
      if (cache.has(path)) {
        const v = cache.get(path);
        cache.delete(path); // reinsere: marca como usado recentemente (LRU)
        cache.set(path, v);
        return v;
      }

      let buf = null;
      try {
        buf = readFileSync(path);
      } catch (e) {
        console.error(`[media] arquivo ausente: ${path} (${e?.message})`);
        cache.set(path, null);
        return null;
      }

      // Maior que o orcamento inteiro: entrega sem cachear (rele a cada envio).
      if (buf.length > budget) return buf;

      cache.set(path, buf);
      bytes += buf.length;
      while (bytes > budget && cache.size > 1) {
        const oldest = cache.keys().next().value;
        const v = cache.get(oldest);
        cache.delete(oldest);
        if (v) bytes -= v.length;
      }
      return buf;
    },

    get bytes() {
      return bytes;
    },
    get size() {
      return cache.size;
    },
  };
}
