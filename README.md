# isigroup

Agendador e automação para WhatsApp — app desktop (Windows). Conecta uma ou mais
contas de WhatsApp e atua sobre grupos/comunidades onde a conta é admin:

- **Agenda mensagens** — texto, imagem, áudio (nota de voz/PTT), vídeo, enquete; disparo único ou recorrente (semanal), com sequências multi-formato e intervalos.
- **Automatiza por gatilho** — entrou / saiu / enviou mensagem (starts_with/contains/exact/ends_with) / contém link → ações combináveis: mensagem no grupo, mensagem no privado, remover do grupo (admin protegido) e webhook.
- **Emite webhooks assinados** (HMAC) com nome do grupo, nome e telefone do lead, automação, mensagem e data/hora.
- **Multi-chip (Pro)** — vários chips com proxy opcional por chip; disparo *group-first* com cobertura e rodízio entre chips.

Pacing é apenas **anti-flood**, nunca para evadir detecção.

> ⚠️ A conexão usa biblioteca não-oficial (Baileys, via Aparelhos Conectados). Use um número **secundário** — há risco de banimento.

## Arquitetura

```
Tauri 2 (core Rust) ──spawn/supervise──> Sidecar Node (HTTP local 127.0.0.1 + token)
        │                                          │
   HWID, keyring, boot-ping de licença        Baileys (pool de sessões), scheduler,
   ciclo de vida do sidecar, updater          automação, SQLite (node:sqlite)
        │
   Front React/TS (gate de licença + UI)
```

- **`src-tauri/`** — core Rust: ciclo de vida do sidecar, HWID, keyring, gate de licença isipanel, auto-updater. (`lib.rs`, `hwid.rs`, `sidecar.rs`, `license.rs`)
- **`sidecar/`** — Node: servidor HTTP local autenticado por token; Baileys, scheduler, automação; SQLite + migrations. (`index.mjs`, `src/*.mjs`, `migrations/*.sql`)
- **`src/`** — front React/TS: `App.tsx`, `components/`, `lib/api.ts`.

Detalhes de arquitetura, fluxos e gotchas em **[CLAUDE.md](CLAUDE.md)**.

## Licença (isipanel)

Boot-ping no arranque (no core Rust): `POST https://api.isitools.com.br/v1/license/validate`
com `{ license_key, hwid, product_slug }`. Os slugs `isigroup-pro`/`isigroup` definem a
edição (Pro/free). HWID = `sha256(CPU + placa + disco)` com prefixo `isigroup-v1:`.
`license_key` no **keyring do OS**, mascarada em logs. Consome **apenas** `/v1/license/validate`.

## Pré-requisitos

- Node **22.5+** (usa `node:sqlite`) — testado em Node 24.
- Rust/cargo (stable) + toolchain do Tauri 2.
- pnpm.

## Rodar (dev)

```bash
pnpm install
pnpm --dir sidecar install
pnpm tauri dev          # sobe vite + core Rust + sidecar (o core lança o sidecar de ./sidecar)
```

## Build e release

```bash
pnpm tauri build        # instalador NSIS em src-tauri/target/release/bundle/nsis/
```

O empacotamento (`scripts/prepare-sidecar.mjs`) embute o runtime Node + o sidecar no
instalador, então o app instalado roda sem Node na máquina. O app tem **auto-updater
assinado** (Tauri + minisign) que lê o `latest.json` da release no GitHub. Processo de
release completo em **[RELEASING.md](RELEASING.md)**.

## Status

Ver **[ROADMAP.md](ROADMAP.md)**. Milestone 1 (Fases 0–6) e Milestone 2 (multi-chip Pro,
Fases A–F) **código-completos**; validação ao vivo do multi-chip com 2+ chips reais é a
pendência aberta. Releases em [`progestaodigital/isiGroup`](https://github.com/progestaodigital/isiGroup/releases).
