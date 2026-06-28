# Roadmap de Execução — isigroup

> **Agendador e Automação para WhatsApp** — app desktop Tauri 2 + React/TS + sidecar Node (Baileys) + SQLite.
> Versão do roadmap: 1.0 · Data base: 2026-06-27 · Owner: Fabio (progestaodigital@gmail.com)
> Documento vivo. Cada fase tem objetivo, tarefas, entregáveis e critério de pronto (DoD).

---

## Princípios de execução

1. **Cada fase fecha com um app que abre e roda.** Nada de fase que deixa o app quebrado.
2. **SQLite é a fonte de verdade.** Fila, regras, logs e sessão sobrevivem a reinício.
3. **Licença é gate de boot.** Sem licença válida (ou dentro do `grace_until`), o app não opera os módulos.
4. **Pacing é para não floodar**, nunca para evadir detecção. No plano **free** a operação é de **conta única, sem proxy**; o plano **Pro** habilita **múltiplos chips e proxy opcional por chip** (Milestone 2) — o pacing continua sendo anti-flood, não evasão.
5. **A ferramenta observa e emite.** Cruzamento de opt-in e decisão de envio oficial vivem no CRM, não aqui.
6. **Reutilizar o contrato isipanel.** `Authorization: Bearer` + boot ping. Nunca header custom.

---

## Visão macro das fases

| Fase | Tema | Entrega central | Depende de |
|---|---|---|---|
| **0** ✅ | Fundação | App Tauri + sidecar + IPC + SQLite + **gate de licença** | — |
| **1** ✅ | Conexão | Pareamento QR, sessão persistida, sync de grupos/comunidades admin | 0 |
| **2** 🟡 | Agendador de texto | Disparo único ✅ confirmado ao vivo. Recorrente semanal + editar/excluir + sequência ✅ implementados. **Recorrente semanal: verificação ao vivo ainda PENDENTE** (lógica testada em unitário). | 1 |
| **3** ✅ | Mídia | Áudio PTT (waveform real), imagem, vídeo, enquete, link-preview, sequência multi-formato | 2 |
| **4+5** ✅ | **Automações & Gatilhos** (unificado) | Gatilhos: entrou/saiu/mensagem(4 matches)/contém-link. Ações: msg no grupo, msg no privado, excluir, webhook (HMAC). **Validado ao vivo (webhook + DM + join/leave) em 2026-06-28.** | 1 |
| **6** 🟡 | Hardening | Instalador NSIS + sidecar embarcado + ícone + arranque não-bloqueante ✅. **Auto-updater nativo assinado (minisign) ✅.** Pacing anti-flood ✅. **Pendente:** live runbook de licença (7 cenários). | 2–5 |
| **A–F** 🆕 | **Multi-chip (Pro)** — Milestone 2 | Vários chips por usuário, proxy por chip, disparo/automação group-first com cobertura e rotação | 1, 2, 4+5, 6 |

> Fases 4 e 5 dependem só da Fase 1 (conexão), então podem ser paralelizadas depois do agendador, se houver banda.

> **Milestone 2 (multi-chip)** é um bloco novo de recurso **exclusivo do plano Pro**, detalhado na seção própria abaixo. Caminho crítico: **A → (B, C em paralelo) → D → E → F**.

> **Verificações pendentes:** disparo **recorrente semanal** ao vivo (lógica já validada em teste unitário; falta confirmação real do usuário num dia/horário agendado).

---

## ✅ Entregue até agora (Milestone 1 — releases v0.1.0 / v0.1.1)

**Fundação & conexão**
- [x] App Tauri 2 + React/TS + sidecar Node (Baileys 7) + `node:sqlite`, IPC local com token — Fase 0 ✅
- [x] Gate de licença isipanel (slug `isigroup`/`isigroup-pro`), HWID, keyring, 5+1 estados — ✅ ao vivo (`valid`)
- [x] Detecção de **edição free/pro** (boot ping tenta `isigroup-pro`→`isigroup`); enforcement no sidecar (`/edition`)
- [x] Pareamento QR, **sessão persistida + reconexão automática no boot**, sync de grupos/comunidades, detecção de admin (ciente de `@lid`)

**Agendador**
- [x] Disparo único ✅ ao vivo; **recorrente semanal** (dia da semana + hora) implementado
- [x] **Editar e excluir** agendamentos; lista separada único × recorrente
- [x] **Sequência multi-formato** (texto/imagem/áudio/vídeo/enquete) com janela de intervalo
- [x] **Mídia:** áudio PTT com **waveform real** (ffmpeg→opus), imagem, vídeo, enquete
- [x] **`@all`** (menção oculta de todos) e **preview de link** (imagem/título/descrição)
- [x] Seleção de **≥1 grupo obrigatória**

**Automações & Gatilhos (unificado)**
- [x] Gatilhos: **entrou / saiu / enviou mensagem (starts_with/contains/exact/ends_with) / contém link**
- [x] Ações combináveis com **intervalo irregular** entre cada uma: msg no grupo, msg no privado, **excluir (trava de admin)**, **webhook (HMAC)**
- [x] Ações de mensagem com toda a riqueza do agendador (formatos + sequência); **editar automações**
- [x] **Webhook enriquecido:** `{ event, automation, group{jid,name}, lead{name,phone,jid}, message, date, time, timestamp }` — telefone real do lead resolvido do evento (questão #6) ✅ ao vivo em 2026-06-28
- [x] Grupos não-admin **gated ao Pro** (free oculta); **sem nenhuma menção a "Pro" na UI** (free só esconde)

**Produto, distribuição & visual**
- [x] **FAQ** focada em risco de banimento
- [x] Repo GitHub `progestaodigital/isiGroup` + **workflow de release** por tag + **aviso de nova versão** na Visão geral (baixar + ver mudanças)
- [x] **Empacotamento:** node.exe + sidecar embarcados como recursos; **instalador NSIS** gerado
- [x] **UX do app instalado:** consoles escondidos (`CREATE_NO_WINDOW`/`windowsHide`), arranque **não-bloqueante** com tela "Iniciando…"
- [x] **Logo isi** aplicado: ícone do app, **ícone do instalador** (`nsis.installerIcon`) e tela de início
- [x] **Redesign visual "Obsidian & Lime"** (lime `#ccff00`, vidro/glassmorphism, Space Grotesk + JetBrains Mono, grid/glow)
- [x] **Auto-updater nativo assinado** (Tauri updater + minisign): a Visão geral baixa/instala a nova versão dentro do app e reinicia; manifesto `latest.json` no GitHub Releases; chave privada fora do repo
- [x] **Releases v0.1.0 / v0.1.1 / v0.1.2 publicadas** (v0.1.2 = primeira com auto-update)

**Pendências conhecidas:** verificação ao vivo do **recorrente semanal**; **live runbook de licença** (7 cenários); estabilidade de `community_announce` (sem comunidades no teste atual).

> **Extra entregue:** `@all` (menção oculta / ping silencioso de todos os membros) no agendador — reversão consciente do "fora de escopo" original, a pedido do dono. ✅ confirmado ao vivo.

---

## Fase 0 — Fundação (setup + licença)

**Objetivo:** esqueleto rodando ponta a ponta. App abre, sidecar sobe supervisionado, IPC local autenticado funciona, SQLite migra, e o **gate de licença** bloqueia/libera o app.

> **STATUS: ✅ CONCLUÍDA (2026-06-27).** App compila (Rust + TS), abre e fica de pé; sidecar sobe supervisionado e responde `/health` autenticado por token; SQLite migrado com as 12 tabelas no app data dir; HWID gerado (`isigroup-v1:…`); gate de licença com os 5+1 estados implementado.
>
> **Decisões tomadas na execução:**
> - **Boot ping no Rust core** (lê HWID nativo + keyring do OS + chama o isipanel via `reqwest`/SChannel).
> - **isigroup consome só `/v1/license/validate`** — sem rotas Bearer-gated (webhooks de eventos vão para o CRM/n8n do operador).
> - **Persistência via `node:sqlite` (embutido no Node 24)** em vez de `better-sqlite3` — este último exige toolchain de build C++ (Python+MSVC) ausente na máquina. `node:sqlite` tem API equivalente, zero dep nativa, e já vem dentro do Node (simplifica o empacotamento do sidecar — questão #2).
> - **IPC:** sidecar bind em `127.0.0.1:0` (porta efêmera) + token de sessão de 32 bytes gerado pelo Rust; sidecar reporta a porta via marcador no stdout; CORS liberado (proteção real é o token).
>
> **Verificação ao vivo: ✅** boot ping testado com license-key real do produto `isigroup` → estado `valid` libera a UI principal (confirmado 2026-06-27). Demais cenários do live runbook (expired/blocked/hwid_mismatch/rate_limit) ficam para a Fase 6 conforme disponibilidade de chaves nesses estados.

### 0.1 Scaffold do app
- [ ] Inicializar projeto **Tauri 2** com front **React + TypeScript** (Vite).
- [ ] Configurar estrutura de pastas: `src/` (front React), `src-tauri/` (Rust core), `sidecar/` (Node/Baileys).
- [ ] Lint/format (ESLint + Prettier no front/sidecar; `cargo fmt`/`clippy` no Rust).

### 0.2 Sidecar Node + ciclo de vida
- [ ] Projeto Node 18+ com servidor HTTP/WS local em `127.0.0.1` (porta efêmera).
- [ ] **Token de sessão** gerado pelo core Rust a cada arranque, injetado no sidecar via env/arg, exigido em todo request (header).
- [ ] Core Rust faz **spawn + supervise + kill** do sidecar junto com o app (sidecar morre quando o app fecha).
- [ ] Endpoint `GET /health` no sidecar → core e front confirmam que está vivo.
- [ ] Reinício automático do sidecar com backoff se ele cair.

### 0.3 Persistência
- [ ] Integrar **better-sqlite3** no sidecar.
- [ ] Sistema de **migrations versionadas** (schema das 10 tabelas do planejamento).
- [ ] Criar todas as tabelas: `accounts`, `targets`, `schedules`, `schedule_targets`, `media_assets`, `automation_rules`, `automation_actions`, `automation_logs`, `membership_events`, `webhooks`.
- [ ] Tabela auxiliar de controle de licença local (`license_state`: status, expires_at, grace_until, last_validated_at).

### 0.4 Gate de licença (isipanel) — **bloqueante**
- [ ] **HWID no Rust core:** `sha256(CPU_ID + Motherboard_UUID + primary_disk_serial)` lowercase hex, prefix `isigroup-v1:`.
- [ ] **Keychain/keyring do OS** via plugin Tauri — armazenar `license_key` (nunca em SQLite/arquivo plain).
- [ ] **Boot ping:** `POST https://api.isitools.com.br/v1/license/validate` com `{ license_key, hwid, product_slug: "isigroup" }`.
- [ ] Tela de **primeira execução**: pede a license-key, salva no keyring em sucesso.
- [ ] Tratar **os 5+1 estados**: `valid` / `invalid` / `hwid_mismatch` / `expired` / `blocked` / `rate_limited (429, respeitar retry_after_s)`.
- [ ] UI usa `subscription_url` / `support_url` **do response** (nunca hard-coded).
- [ ] Cache local de `valid` até `grace_until`; re-valida no próximo arranque.
- [ ] **license_key mascarada** em todo log (`ISI-****-****-****-XXXX`).
- [ ] Re-boot ping a cada arranque do app.

**DoD Fase 0:**
App abre → core sobe o sidecar → `/health` responde com token válido → SQLite migrado → boot ping retorna `valid` e libera a UI principal; estados `invalid/expired/blocked/hwid_mismatch` mostram a tela correta com os links do response; `rate_limited` respeita o backoff.

**Riscos/decisões:** empacotamento do sidecar (Node embarcado vs binário único) — decidir aqui ou marcar para Fase 6; encaixe do contrato de licença confirmado (slug `isigroup` ✅).

---

## Fase 1 — Conexão e sincronização

**Objetivo:** parear a conta de WhatsApp por QR, persistir a sessão, e listar os grupos/comunidades onde a conta é admin.

### 1.1 Pareamento
- [ ] `makeWASocket` + `useMultiFileAuthState` (sessão persistida em disco, fora do plain SQLite).
- [ ] Capturar QR do evento `connection.update` e renderizar na UI React.
- [ ] **Reconexão com backoff** (evitar loop agressivo — sinal suspeito).
- [ ] Persistir `accounts` (status: `connected` / `disconnected` / `qr_pending`).

### 1.2 Sincronização de alvos
- [ ] `groupFetchAllParticipating()` → filtrar onde a conta é admin.
- [ ] **Classificar** cada alvo: `group` / `community_announce` / `community_subgroup` (ler flags de comunidade).
- [ ] Popular/atualizar tabela `targets` com `last_synced_at`.
- [ ] Botão "Sincronizar" + sync automático ao conectar.

### 1.3 Validação crítica (questão em aberto #1)
- [ ] **Testar na versão atual da Baileys** a estabilidade de post no **grupo de avisos da comunidade** (`community_announce`).
- [ ] Se instável → ativar fallback: mirar sub-grupos individualmente. Manter os dois caminhos no design.

**DoD Fase 1:**
Pareia por QR, reconecta sozinho após queda, lista corretamente grupos e comunidades onde é admin com classificação certa; resultado da validação de `community_announce` documentado (estável ou fallback).

---

## Fase 2 — Agendador de texto

**Objetivo:** agendar mensagem de texto, disparar no horário exato, registrar log, sobreviver a reinício.

### 2.1 Worker de fila
- [ ] Worker leve no sidecar que lê `schedules` + `schedule_targets` do SQLite.
- [ ] **Re-hidratação no boot:** ao subir, recalcula próximos disparos (reinício não perde agendamento).
- [ ] Cálculo de próximo disparo e armazenamento de status (`pending`/`sent`/`partial`/`failed`/`canceled`).

### 2.2 Modos de conteúdo
- [ ] `broadcast` — mesma mensagem para todos os alvos (`default_json`).
- [ ] `per_target` — override por grupo (`schedule_targets.message_json`).
- [ ] UI de criação: selecionar alvos, escrever conteúdo, escolher modo, definir horário.

### 2.3 Disparo
- [ ] Alvo único (comunidade/avisos) → envio único.
- [ ] Vários grupos → **envio sequencial com espaçamento curto e levemente aleatório** (poucos segundos) — anti-flood/rate limit.
- [ ] `sendMessage(jid, { text })`.
- [ ] Atualizar status por alvo (`sent_at`, `error`) e status agregado do schedule.

### 2.4 Histórico
- [ ] Tela de histórico de envios com status por alvo.
- [ ] Ação de cancelar agendamento pendente.

**DoD Fase 2:**
Cria agendamento de texto, dispara no horário com espaçamento entre grupos, registra log por alvo; ao reiniciar o app no meio, o agendamento futuro continua válido e dispara.

---

## Fase 3 — Mídia

**Objetivo:** áudio como nota de voz (PTT) com waveform, vídeo e enquete.

### 3.1 Upload e armazenamento
- [ ] UI de anexar mídia; gravar em `media_assets` (path, mimetype, kind, duration).
- [ ] Validação de formato/tamanho.

### 3.2 Áudio PTT (questão em aberto #3)
- [ ] `sendMessage(jid, { audio: buffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' })`.
- [ ] **Gerar `waveform`** (array de amplitudes a partir do PCM) e `seconds` → renderiza como nota de voz "bonita".
- [ ] Decidir: biblioteca pronta vs cálculo próprio a partir do PCM.

### 3.3 Vídeo e enquete
- [ ] Vídeo: `sendMessage(jid, { video: buffer, caption })`.
- [ ] Enquete: `sendMessage(jid, { poll: { name, values, selectableCount } })`.
- [ ] UI específica para montar enquete (nome + opções + seleção).

**DoD Fase 3:**
Os 4 formatos (texto já vindo da Fase 2, + áudio PTT com waveform, vídeo, enquete) agendam e disparam corretamente; áudio aparece como nota de voz com ondinha no WhatsApp.

---

## Fase 4 — Automação por gatilho

**Objetivo:** regras que reagem a mensagens recebidas nos grupos, com ações combináveis.

### 4.1 Engine de match
- [ ] Escutar mensagens recebidas nos alvos.
- [ ] **Tipos de match:** `starts_with`, `contains`, `ends_with`, `exact` + flag `case_sensitive`.
- [ ] Escopo por regra (`scope_json` — em quais alvos vale).
- [ ] Persistir em `automation_rules` (enabled on/off).

### 4.2 Ações combináveis (`automation_actions`, com `order_index`)
- [ ] `reply` — responde no grupo.
- [ ] `remove` — remove o autor. **Trava de segurança: admin nunca é removido por gatilho.**
- [ ] `webhook` — dispara o webhook de match (integra com Fase 5).

### 4.3 Auditoria
- [ ] Toda execução registrada em `automation_logs` (rule_id, target_jid, sender_e164, matched_text, actions_taken).
- [ ] Tela de logs de automação.

**DoD Fase 4:**
Regras com os 4 matches funcionam; ações reply/remove/webhook executam e são logadas; a trava de admin impede autoexpulsão mesmo em regra mal configurada.

---

## Fase 5 — Eventos e webhooks

**Objetivo:** observar entrada/saída de membros e emitir webhook assinado, com número em E.164.

### 5.1 Captura de eventos
- [ ] Escutar `group-participants.update` (action `add` / `remove`).
- [ ] Normalizar número para **E.164** (`+55...`).
- [ ] Persistir em `membership_events` (event_type `join`/`leave`, webhook_status).

### 5.2 Entrega de webhook
- [ ] Configuração de `webhooks` (url, secret, events_json, enabled).
- [ ] **Assinatura HMAC** com o `secret` (CRM valida origem).
- [ ] Payloads canônicos: `group.member_joined`, `group.member_left`, `automation.match`.
- [ ] **Retry com backoff** em falha; status `pending`/`delivered`/`failed`.
- [ ] Tela de configuração de webhooks + log de entregas.

### 5.3 Integração com automação
- [ ] Conectar ação `webhook` da Fase 4 ao emissor (evento `automation.match`).

**DoD Fase 5:**
Join/leave geram webhook assinado HMAC com E.164, grupo e timestamp; entrega tem retry e status; CRM consegue validar a assinatura. (Cruzamento de opt-in e envio oficial ficam no CRM, fora desta ferramenta.)

---

## Fase 6 — Hardening e empacotamento

**Objetivo:** deixar pronto para instalar e operar de forma resiliente.

### 6.1 Resiliência e pacing
- [ ] Revisar/centralizar **pacing** entre envios (config de janela mínima/aleatoriedade).
- [ ] Tratamento de rate limit do WhatsApp; fila não trava em erro de um alvo.
- [ ] Recuperação de sessão após queda longa.

### 6.2 Observabilidade
- [ ] Logging estruturado (sem PII; license_key mascarada).
- [ ] Painel de status: conexão, fila, último sync, saúde do sidecar.

### 6.3 Empacotamento e distribuição (questão em aberto #2)
- [ ] **Estratégia de empacotamento do sidecar** (Node embarcado vs binário único — `pkg`/`nexe`/sea).
- [ ] Instalador Tauri (Windows primeiro; macOS/Linux se aplicável).
- [x] **Updater** do Tauri configurado e assinado (minisign; endpoint `latest.json` no GitHub Releases). ✅

### 6.4 Compliance final
- [ ] Avisos de risco (Baileys não-oficial; recomendar **número secundário**).
- [ ] Texto sugerido para descrição do grupo informando automação (boa prática LGPD).
- [ ] Confirmar contrato de licença isipanel encaixado e funcionando em produção.

**DoD Fase 6:**
Instalador gerado, app atualiza sozinho, opera de forma estável com pacing correto, e passa pelo **live runbook de licença** (7 cenários do contrato isipanel).

---

## Milestone 2 — Multi-chip (plano Pro)

> **Versão do milestone:** 2.0 · Data base: 2026-06-27 · Status: ✅ **código completo (A–F) em 2026-06-28** — validação ao vivo com 2+ chips reais pendente
>
> **Objetivo do milestone:** permitir que o usuário Pro conecte **vários chips de WhatsApp** (cada um com proxy opcional) e, nos disparos e automações, escolha **quais chips usar** sobre um conjunto de grupos. O modelo é **group-first + cobertura**: o usuário seleciona os grupos primeiro, e o sistema mostra/garante quais chips cobrem esses grupos (um chip não precisa estar em todos os grupos; cada grupo precisa de ≥1 chip membro). A rotação de envio é **round-robin por grupo** entre os chips que já são membros — nunca fazendo chip entrar em grupo (decisão consciente: elimina o risco de ban por entrada/adição em massa e a dependência de link de convite).

### Decisões de produto travadas

| Tema | Decisão |
|---|---|
| Modelo de seleção | **group-first + cobertura** (não interseção). Grupos primeiro → chips elegíveis depois. |
| Rotação | **Round-robin por grupo** entre chips membros (não global) — melhor anti-ban. |
| Entrar em grupos | **Não.** O sistema nunca faz chip entrar/ser adicionado a grupo. Trabalha só com o que o chip já é membro. |
| Limite de chips | **Free = 1 chip. Pro = ilimitado** (com **aviso suave** na UI a partir de ~5–6 chips sobre peso/risco). |
| Proxy | **Opcional por chip**, **SOCKS5 + HTTP/HTTPS** (esquema detectado pela URL). |
| Grupo descoberto | Se um grupo-alvo não tiver nenhum chip selecionado que seja membro → **avisa e pula** o grupo, registrando `skipped_no_coverage` no relatório. |
| Gating | Recurso **exclusivo do Pro**, com enforcement no **sidecar** (não só na UI). |

### Premissas técnicas (do mapeamento do código)

- **O banco já é multi-conta:** `account_id` é FK em `accounts`, `targets`, `schedules`, `automation_rules`. Pouca migração estrutural.
- **O runtime é single-session:** `sidecar/src/whatsapp.mjs` captura **um** `sock` num closure; auth em `wa-session/`. É o maior refactor.
- **Sem proxy hoje:** `makeWASocket` é criado sem `agent`.
- **Convergência de envio:** ambos os fluxos terminam em `wa.sendContent(jid, content)` → vira `wa.sendContent(accountId, jid, content)`.
- **Armadilha das automações:** com N chips no mesmo grupo, o evento `messages.upsert` dispara **N vezes** (uma por sessão) → exige **dedup por (grupo, id-da-mensagem)** e regra de "qual chip responde".

---

### Fase A — Pool de sessões (fundação) — ✅ CONCLUÍDA (2026-06-28)

> `whatsapp.mjs` virou pool (`Map<accountId, session>`), auth em `wa-session/<id>/`,
> migração da sessão legada -> `/1/`, API single-chip preservada (delega à conta
> primária), `bootReconnect` religa todas. Verificado: 1 chip idêntico ao anterior.

**Objetivo:** transformar o runtime single-session em pool, sem mudar comportamento com 1 chip.

- [ ] Refatorar `sidecar/src/whatsapp.mjs`: de `sock` único para `Map<accountId, { sock, state, handlers, saveCreds }>`.
- [ ] Layout de auth por conta: `wa-session/<accountId>/` (migrar a sessão existente para `accountId = 1`).
- [ ] Ciclo de vida (QR, `connection.update`, reconexão com backoff) **por sessão**, isolado.
- [ ] APIs internas (`start`, `logout`, `getState`, `syncTargets`, `sendContent`, `isConnected`, handlers) passam a receber/rotear por `accountId`.
- [ ] Auto-reconexão no boot itera todas as contas com `creds.json`.

**DoD:** com 1 chip, o app funciona idêntico ao atual; internamente já é pool; conectar/desconectar/reconectar de uma conta não afeta as outras.

---

### Fase B — Gestão de chips + proxy (Pro) — ✅ CONCLUÍDA (2026-06-28)

> Endpoints `/accounts` (CRUD + connect/logout/sync/proxy/status); gating no sidecar
> (free=1, 2º chip -> 403); proxy por chip (socks5/http). Tela `ConnectionsView`
> multi-chip (QR/status/proxy/remover por chip). Verificado por smoke test.

**Objetivo:** UI para conectar/gerenciar vários chips, cada um com proxy opcional.

- [ ] Migração: `accounts` ganha `label`, `proxy_url`, `proxy_enabled`.
- [ ] `makeWASocket` recebe `agent` por sessão; libs `socks-proxy-agent` + `https-proxy-agent`, esquema detectado pela URL (`socks5://` vs `http(s)://`).
- [ ] Endpoints: `POST /accounts`, `DELETE /accounts/:id`, `POST /accounts/:id/connect`, `POST /accounts/:id/logout`, `GET /accounts/:id/status` (QR e status por conta).
- [ ] Nova tela React "Conexões": listar chips, adicionar (QR), status online/offline, configurar/testar proxy, remover.
- [ ] Gating: Free = 1 chip; Pro = ilimitado, com **aviso suave** a partir de ~5–6 chips.

**DoD:** usuário Pro conecta ≥2 chips, cada um opcionalmente via proxy distinto; cada chip pareia por QR e mostra status independente; Free permanece limitado a 1.

---

### Fase C — Sync por conta + matriz de cobertura — ✅ CONCLUÍDA (2026-06-28)

> `syncTargets` por sessão (popula `targets` por `account_id`); endpoint `/coverage`
> devolve, por chip, quais grupos cobre + os grupos descobertos. Sync por chip na UI.
> Verificado: chip1={gA,gB}, chip2={gB,gC}, descoberto={gD}.

**Objetivo:** saber, de forma confiável, quais chips são membros de quais grupos.

- [ ] `syncTargets` roda por sessão e popula `targets` por `account_id` (admin detectado por sessão — cuidado com `@lid`, ver questão #6).
- [ ] Endpoint `POST /coverage`: recebe um conjunto de JIDs de grupo + lista de `accountId` candidatos → devolve, por chip, quais grupos ele cobre, e a lista de **grupos descobertos**.
- [ ] (Front) helper que consome `/coverage` e monta a matriz chip × grupo.

**DoD:** dado um conjunto de grupos, o sistema responde corretamente quais chips cobrem cada grupo e quais grupos ficam sem cobertura.

---

### Fase D — Disparo group-first + cobertura + rotação — ✅ CONCLUÍDA (2026-06-28)

> Migration 008 (`schedule_targets.account_id`); `scheduler.mjs` roteia por chip
> (round-robin por grupo resolvido no submit), grupos sem cobertura = `skipped_no_coverage`;
> `SchedulerView` group-first (grupos distintos → seletor de chips → prévia de descobertos).
> 1 chip = idêntico ao anterior. Verificado: roteamento grupo→chip gravado certo.

**Objetivo:** redesenhar o disparo para o modelo group-first com rotação por grupo.

- [ ] Migração: `schedule_targets` ganha `account_id` (qual chip envia aquele grupo) e aceita status `skipped_no_coverage`.
- [ ] `SchedulerView` invertido: **seleciona grupos → mostra chips com "cobre X de Y" → seleciona chips → avisa grupos descobertos** (que serão pulados).
- [ ] `scheduler.mjs`: para cada grupo, escolhe um chip elegível e **rotaciona round-robin por grupo** entre os chips membros selecionados; chama `wa.sendContent(accountId, jid, content)`.
- [ ] Grupos sem cobertura → marcados `skipped_no_coverage` e exibidos no relatório.

**DoD:** disparo Pro distribui os grupos entre os chips selecionados via rotação por grupo; grupos descobertos são pulados e reportados; Free segue com chip único.

---

### Fase E — Automações multi-chip — ✅ CONCLUÍDA (2026-06-28)

> Dedup de eventos por (grupo, msg-id / evento) entre as sessões → dispara 1x.
> Chip que responde = menor chip conectado membro do grupo; `remove` usa o menor
> chip admin (questão #6 por chip). Verificado: boot + sintaxe.

**Objetivo:** automação reativa funcionando com vários chips, sem duplicar ações.

- [ ] **Dedup de triggers** por (grupo, id-da-mensagem) entre as sessões dos chips selecionados.
- [ ] Seleção de chips por automação (mesmo modelo de cobertura da Fase C/D).
- [ ] Regra de "chip que responde": default = chip selecionado de menor índice que seja membro daquele grupo (ações tipo `remove` continuam exigindo admin naquele chip).
- [ ] `AutomationView` ganha seleção de chips + aviso de grupos descobertos no escopo.

**DoD:** uma mensagem num grupo com N chips dispara a automação **uma vez**; a ação é executada por um único chip; `remove` respeita admin por chip.

---

### Fase F — Gating, propagação de accountId e polish — ✅ CONCLUÍDA (2026-06-28)

> Gating no sidecar (free=1, 2º chip→403). Migration 009 (`automation_logs.account_id`);
> webhook ganha bloco `chip{account_id,label}`; log + `/automation/logs` trazem o chip;
> `AutomationView` mostra a tag do chip. FAQ (Pro) explica group-first/cobertura/rodízio.

**Objetivo:** fechar o recurso como Pro de verdade e propagar a identidade do chip ponta a ponta.

- [ ] Enforcement no sidecar: rejeitar 2º chip / endpoints multi-chip quando `edition !== 'pro'` (não confiar só na UI).
- [ ] Propagar `accountId` até `automation_logs`, status de disparo e **webhook enriquecido** (qual chip enviou/reagiu).
- [ ] Relatórios mostram envio por chip; aviso suave de muitos chips.
- [ ] Documentar no FAQ (variante Pro) o modelo group-first/cobertura/rotação.

**DoD:** recurso indisponível e bloqueado no sidecar fora do Pro; logs, relatórios e webhooks identificam o chip; FAQ atualizado.

---

## Questões em aberto rastreadas

| # | Questão | Fase de resolução | Status |
|---|---|---|---|
| 1 | Estabilidade de post em `community_announce` na Baileys atual | Fase 1 | ⏳ validar (sem comunidades no teste atual; reavaliar quando houver) |
| 2 | Empacotamento do sidecar (Node embarcado vs binário único) | Fase 6 | ✅ resolvido — node.exe + sidecar (node_modules) embarcados como recursos do Tauri; instalador NSIS gerado e sidecar embarcado validado |
| 3 | Geração da waveform do áudio PTT (lib vs cálculo próprio) | Fase 3 | ✅ resolvido — `ffmpeg-static` transcodifica p/ opus/ogg + waveform real do PCM |
| 4 | Limite real de membros de comunidade (2.000 vs 5.000) | Fase 1 (verificar) | ⏳ |
| 5 | Plano de licença (proxy vs BYOK) — isigroup tende a só `validate` | Fase 0 | ✅ resolvido — **só `validate`**, sem rotas Bearer-gated |
| 6 | **LID → telefone E.164.** Baileys 7 identifica participantes por `@lid`, não pelo número. | Fase 4/5 | ✅ resolvido (join/leave) — Baileys 7 entrega `participant.phoneNumber` no evento de entrada/saída; o webhook leva o telefone real (ex. `5521996687008`). Cache lid→telefone e nome (pushName/contatos) reaproveitado no gatilho de mensagem. |

---

## Checklist de licença (do contrato isipanel) — aplicado à isigroup

- [ ] Produto cadastrado no painel — **slug `isigroup` ✅**
- [ ] Boot ping `POST /v1/license/validate` no arranque
- [ ] license_key no **keyring do OS**
- [ ] HWID de hardware com prefix `isigroup-v1:`
- [ ] Todos os 5+1 estados tratados na UI
- [ ] license_key mascarada em logs
- [ ] `subscription_url`/`support_url` do response (não hard-coded)
- [ ] HTTP 429 → respeitar `retry_after_s`
- [ ] **Sem** rotas Bearer-gated (webhooks vão para o CRM/n8n do operador) — confirmar plano
- [ ] Live runbook: 7 cenários validados na Fase 6
