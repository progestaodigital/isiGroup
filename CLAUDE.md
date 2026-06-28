# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é

**isigroup** — app desktop (Windows) de agendamento e automação para WhatsApp.
Tauri 2 (core Rust) + React/TS (front) + sidecar Node (Baileys + SQLite). Conecta
contas de WhatsApp e atua nos grupos/comunidades onde a conta é admin: agenda
mensagens (texto/imagem/áudio PTT/vídeo/enquete, com sequências), automatiza por
gatilho (entrou/saiu/mensagem/contém-link → mensagem/DM/remover/webhook) e emite
webhooks assinados (HMAC). Pacing é só anti-flood, **nunca** para evadir detecção.

## Comandos

```bash
pnpm install                 # deps do front
pnpm --dir sidecar install   # deps do sidecar (Baileys, ffmpeg-static, proxy agents…)
pnpm tauri dev               # app completo: vite (1420) + core Rust + sidecar
pnpm build                   # front: tsc + vite build (também é o typecheck)
pnpm tauri build             # build de produção (instalador NSIS); assina se env de assinatura estiver setado
```

- **Não há suíte de testes automatizada.** Verificação = `node --check <arquivo.mjs>` para sintaxe + **smoke test**: subir o sidecar contra um DB temporário e bater nos endpoints.
  ```bash
  cd sidecar
  TMP=/tmp/isi; rm -rf $TMP; mkdir -p $TMP
  ISI_SIDECAR_TOKEN=t ISI_DB_PATH=$TMP/test.db node index.mjs &   # imprime __SIDECAR_READY__{"port":N} no stdout
  curl -s -H "x-isi-token: t" http://127.0.0.1:N/health
  ```
  Para semear dados use uma 2ª conexão `node:sqlite` (WAL permite escrita concorrente). `matches`/`hasUrl` em `automation.mjs` são exportados para teste unitário, mas não há runner configurado.
- **Front em dev recarrega na hora (HMR).** Mudanças em `sidecar/` ou `src-tauri/` exigem reiniciar o `tauri dev` (o watcher do Tauri só observa `src-tauri`; o Rust recompila sozinho, mas o sidecar só reinicia com o app).
- **Pré-requisitos:** Node **22.5+** (usa `node:sqlite`; testado em Node 24), Rust stable + toolchain Tauri 2, pnpm. Ambiente é Windows (PowerShell + Bash disponíveis).

## Arquitetura — três processos

```
Tauri core (Rust)  ──spawn/supervise/kill──>  Sidecar (Node)
  HWID, keyring, boot-ping de licença            Baileys (pool de sessões), scheduler,
  resolve+lança o sidecar, mata no exit          automação, SQLite (node:sqlite), HTTP local
        │  expõe comandos via #[tauri::command]        ▲
        ▼                                              │ HTTP 127.0.0.1:porta-efêmera + header x-isi-token
  Front (React/TS)  ──fetch──────────────────────────┘
  gate de licença + UI
```

- **IPC core→sidecar→front:** o Rust gera um **token de sessão** (32 bytes), passa por env ao sidecar, e o sidecar exige `x-isi-token` em toda rota. O sidecar faz bind em **porta efêmera** (`127.0.0.1:0`) e imprime `__SIDECAR_READY__{json}` no stdout; o Rust lê esse marcador para descobrir a porta e a repassa ao front via comando `get_sidecar_info`. CORS é liberado (a proteção real é o token).
- **Arranque não-bloqueante:** `lib.rs::setup` registra um `AppState` em estado `"loading"` e roda HWID + spawn do sidecar + boot-ping numa **thread em segundo plano** (`init_background`); a janela abre na hora ("Iniciando…") e o front faz polling de `get_license_state` até resolver.
- **Front:** `App.tsx` decide entre tela de loading / `LicenseGate` / `MainShell` pelo estado da licença. `lib/api.ts` é a única camada de acesso (comandos Tauri + `fetch` ao sidecar via helper `sidecar<T>()`).

## Licença (isipanel) — gate de boot, feito no Rust

Boot-ping no arranque e a cada revalidação: `POST https://api.isitools.com.br/v1/license/validate`
com `{ license_key, hwid, product_slug }`. `license.rs` tenta os slugs em ordem
(`isigroup-pro` → `isigroup`); o slug que valida define a **edição** (`pro`/`free`)
em `LicenseState.edition`. HWID = `sha256(CPU+placa+disco)` com prefixo `isigroup-v1:`.
`license_key` vive no **keyring do OS** (nunca em arquivo), mascarada em logs.
Consome **apenas** `/v1/license/validate` — sem rotas Bearer-gated.

A edição propaga para o sidecar via `POST /edition` (`MainShell` chama `setSidecarEdition`),
que controla o **gating** dos recursos Pro **no motor** (não só na UI).

## Modelo de dados e fluxos (o que exige ler vários arquivos)

- **SQLite via `node:sqlite`** (não better-sqlite3 — evita toolchain nativo). Sem helper de transação: usar `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` manual. Migrations em `sidecar/migrations/NNN_*.sql`, aplicadas uma vez e rastreadas em `_migrations` (`db.mjs`). **Toda mudança de schema é uma migration nova; nunca editar as existentes.**
- **Pool multi-chip** (`whatsapp.mjs`): `createWhatsApp` gerencia `Map<accountId, session>`; cada conta tem `sock`/estado/cache/dir de auth (`wa-session/<accountId>/`) isolados. **As funções single-chip (`start`/`sendContent`/`syncTargets`…) delegam para a conta primária (menor id)** — com 1 chip o comportamento é idêntico ao legado. Há também a API por conta (`startAccount`/`accountSend`/`isAccountConnected`…). `account_id` é FK em `targets`/`schedules`/`automation_rules`/`schedule_targets`/`automation_logs`.
- **Disparo group-first** (`SchedulerView` + `index.mjs::createSchedule` + `scheduler.mjs`): o usuário seleciona **grupos distintos** e **chips**; o front resolve o roteamento (round-robin por grupo entre chips que cobrem o grupo, via `/coverage`) e envia `targets: [{target_id, account_id, skipped?}]`. O scheduler envia cada alvo pelo chip do `account_id` (`sendVia`; `null` = primária). Grupos sem cobertura ⇒ `skipped_no_coverage`.
- **Automação multi-chip** (`automation.mjs`): os handlers `onMessage`/`onMembership` recebem `account_id`+`msg_id` e fazem **dedup** por (grupo, msg-id/evento) — N chips no mesmo grupo disparam a regra **1×**. O "chip que responde" é o menor chip **conectado** membro do grupo (`responderFor`); `remove` usa o menor chip **admin** (`adminResponderFor`). Trava: admin nunca é removido por gatilho.
- **Webhook** (`webhooks.mjs`): `POST` JSON assinado com HMAC-SHA256 (header `x-isi-signature`), retry com backoff. Payload inclui `chip{account_id,label}`, `group{jid,name}`, `lead{name,phone,jid}`, `message`, `date`/`time`. O telefone do lead vem de `participant.phoneNumber` nos eventos join/leave (Baileys 7 usa `@lid` para participantes — ver gotcha).

## Empacotamento e release (auto-updater assinado)

- **`scripts/prepare-sidecar.mjs`** (roda no `beforeBuildCommand`): copia o `node.exe` em uso + o código do sidecar + `node_modules` (npm plano) para `src-tauri/resources/` (embutidos pelo Tauri). **Sincroniza a versão do `sidecar/package.json` com a do app** — o `/health` reporta essa versão na tela "Sidecar". `src-tauri/resources/` é gitignorado exceto `keep.txt`.
- **Auto-updater (Tauri):** o app lê `latest.json` da release `latest` no GitHub, valida a assinatura **minisign** (pubkey em `tauri.conf.json::plugins.updater.pubkey`) e instala. Releases precisam do `.exe` **assinado** + `latest.json` (gerado por `scripts/make-latest-json.mjs`). Processo completo em **`RELEASING.md`**.
- A chave privada de assinatura é **`isigroup-updater.key`** (raiz, **gitignorada**) + senha `isigroup-updater-2026`. Build assinado: setar `TAURI_SIGNING_PRIVATE_KEY` (= conteúdo do arquivo) e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Se o bundler pular a assinatura, assinar o `.exe` à mão com `pnpm tauri signer sign -f isigroup-updater.key -p <senha> <exe>`.
- **Bump de versão = 4 arquivos:** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `sidecar/package.json` (o `prepare-sidecar` garante o bundle, mas o source do sidecar é o que o dev lê).

## Gotchas específicos

- **`@lid`:** o WhatsApp identifica participantes por `@lid`, não pelo telefone. Detecção de admin/“eu mesmo” casa por `id`/`jid`/`lid`. O telefone real só é confiável nos eventos join/leave (`participant.phoneNumber`); para mensagens, usa-se cache `lid→telefone` alimentado por esses eventos.
- **Windows / caminhos verbatim:** `resource_dir()`/`app_data_dir()` retornam caminhos com prefixo `\\?\` que o Node não carrega — `lib.rs::strip_verbatim` remove. Processos filhos (sidecar, ffmpeg, PowerShell do HWID) usam `CREATE_NO_WINDOW`/`windowsHide` para não piscar terminal.
- **PowerShell `Set-Content -Encoding utf8` adiciona BOM** e quebra o parse de JSON pelo Vite/Node. Para editar `package.json`/`tauri.conf.json` use a ferramenta de edição (sem BOM) ou `[System.IO.File]::WriteAllText` com UTF8 sem BOM.
- **Áudio:** WhatsApp só entrega nota de voz (PTT) em **opus/ogg**; `media.mjs` transcodifica com `ffmpeg-static` e extrai waveform real do PCM.
- **`@all`:** menção oculta de todos os membros (array `mentions` sem poluir o texto) — tratado em `sendContent`.
- **Commits:** mensagens terminam com `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Em PowerShell, evitar here-string para a mensagem (parsing frágil) — preferir `git commit -F <arquivo>`.

## Estado do projeto

Ver **`ROADMAP.md`**. Milestone 1 (Fases 0–6) e Milestone 2 (multi-chip Pro, Fases A–F)
estão **código-completos**; a validação ao vivo do multi-chip com 2+ chips reais é a
pendência aberta. Releases publicadas em `progestaodigital/isiGroup`.
