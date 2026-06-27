# isigroup

Agendador e automação para WhatsApp — app desktop. Conecta uma conta de WhatsApp
e atua sobre grupos/comunidades onde a conta é admin: **agenda mensagens**
(texto, áudio PTT, vídeo, enquete), **automatiza por gatilho** (match → responder /
remover / webhook) e **emite eventos** de entrada/saída via webhook para o CRM.

Conta única, sem proxy/rotação. Pacing apenas anti-flood, nunca para evadir detecção.

## Arquitetura

```
Tauri 2 (Rust core) ── spawn/supervise ──> Sidecar Node (HTTP local 127.0.0.1 + token)
        │                                          │
   HWID, keyring, boot ping de licença        Baileys, scheduler, eventos
   ciclo de vida do sidecar                   SQLite (node:sqlite)
        │
   Front React/TS (gate de licença + UI)
```

- **`src-tauri/`** — core Rust: ciclo de vida do sidecar, HWID, keyring, gate de licença isipanel.
  - `hwid.rs` · `sidecar.rs` · `license.rs` · `lib.rs`
- **`sidecar/`** — Node: servidor HTTP local autenticado por token, SQLite + migrations.
  - `index.mjs` · `src/db.mjs` · `migrations/*.sql`
- **`src/`** — front React: `App.tsx`, `components/LicenseGate.tsx`, `components/MainShell.tsx`, `lib/api.ts`.

## Licença (isipanel)

Boot ping no arranque: `POST https://api.isitools.com.br/v1/license/validate` com
`{ license_key, hwid, product_slug: "isigroup" }`. Feito no **core Rust**.
HWID = `sha256(CPU_ID + Motherboard_UUID + disk_serial)` com prefix `isigroup-v1:`.
`license_key` salva no **keyring do OS** (nunca em disco plain), mascarada em logs.
isigroup consome **apenas** `/v1/license/validate` (sem rotas Bearer-gated).

## Pré-requisitos

- Node 22.5+ (usa `node:sqlite`) — testado em Node 24.
- Rust/cargo (stable) + toolchain do Tauri 2.
- pnpm.

## Rodar

```bash
pnpm install            # deps do front
pnpm --dir sidecar install   # (sidecar não tem deps externas hoje)
pnpm tauri dev          # sobe vite + core + sidecar
```

O Rust core sobe o sidecar automaticamente (caminho de dev: `./sidecar/index.mjs`).
Empacotamento do sidecar para produção fica na Fase 6.

## Status

Ver [ROADMAP.md](ROADMAP.md). **Fase 0 (fundação + gate de licença) concluída.**
Próxima: Fase 1 — conexão por QR e sincronização de grupos/comunidades.
