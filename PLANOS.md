# Planos de ação (isiplan) & Integração com IA (MCP)

Duas formas de uma IA operar o isigroup, construídas sobre a **mesma fundação**
(o formato declarativo *isiplan* + o executor de planos do sidecar):

1. **Arquivo isiplan** — uma IA em *qualquer* máquina gera um plano (JSON/zip);
   o usuário importa em **Planos & IA → Importar plano**, revisa a prévia e
   confirma. Cobre o fluxo cross-máquina.
2. **Ponte MCP** — uma IA *nesta* máquina (ex.: Claude Code) opera o app ao
   vivo por ferramentas MCP. Ações de risco pedem aprovação dentro do app.

Nenhum caminho executa nada sem confirmação humana, e os limites anti-banimento
do app (30 criações / 30 adições por disparo, ritmo aleatório) valem por
construção — o executor delega para as filas existentes (bulk/scheduler/regras).

---

## 1. O formato isiplan

### Contêineres

| Formato | Quando usar |
| --- | --- |
| `.isiplan` / `.zip` | **Canônico.** `plan.json` na raiz + pasta `media/` com imagens/áudios/vídeos referenciados. |
| `.json` solto | Plano sem mídia (ou só imagens pequenas inline em base64, ≤ 2 MB). |

Limites: 50 ações por plano · `plan.json` ≤ 10 MB · pacote ≤ 200 MB.
Áudio é transcodificado automaticamente para nota de voz (PTT opus + waveform).

### Estrutura

```json
{
  "isigroup_plan": 1,
  "name": "Setup turmas de outubro",
  "requires": { "app": ">=0.1.15", "edition": "pro" },
  "defaults": { "pace": "slow", "chip": "auto", "on_error": "continue" },
  "actions": [
    { "id": "turmas", "type": "create_groups",
      "params": { "name": "Turma {x}", "quantity": 3, "start": 10,
                  "description": "Avisos da turma", "image": { "file": "media/capa.png" },
                  "admins": ["5511999998888"], "members": ["5521988887777"] } },
    { "type": "schedule",
      "params": { "targets": { "ref": "turmas" }, "kind": "recurring",
                  "recur_dow": 1, "recur_time": "09:00",
                  "steps": [ { "type": "text", "text": "Bom dia! Agenda da semana 👇" },
                             { "type": "audio", "media": { "file": "media/bomdia.mp3" } } ] } },
    { "type": "automation_rule",
      "params": { "name": "Boas-vindas", "trigger_type": "join", "scope": { "ref": "turmas" },
                  "actions": [ { "type": "dm", "steps": [ { "type": "text", "text": "Bem-vindo!" } ] } ] } }
  ]
}
```

### Seletores de grupos (o plano nunca traz jids)

| Seletor | Semântica |
| --- | --- |
| `{"ref": "id"}` | Grupos criados pela ação `create_groups` de id `"id"` neste plano. Opcional `"indices": [0, 2]`. |
| `{"names": ["Nome Exato"]}` | Nome exato (case-insensitive) entre os grupos sincronizados. Cada nome deve resolver para **exatamente um** grupo. |
| `{"match": "Turma *"}` | Padrão glob sobre os nomes. Zero resultados = passo pulado com aviso. |

Chips por rótulo: `"chip": "auto"` (padrão) ou `{"label": "Chip vendas"}`;
agendamentos aceitam `"chips": ["A", "B"]` (pool multi-chip, Pro).

### Tipos de ação (v1)

`create_groups` · `add_members` · `remove_members` · `promote` · `demote` ·
`edit_groups` · `schedule` · `automation_rule` · `save_selection`

A especificação completa (params de cada ação + exemplo) é servida pelo próprio
app em `GET /plans/schema` — e embutida no botão **"Copiar instruções para a
IA"** (aba Planos & IA), que gera um prompt pronto para colar no Claude/ChatGPT
de outra máquina (opcionalmente com os nomes reais dos seus grupos e chips).

### Fluxo de importação

`upload → validação → prévia (obrigatória) → confirmação → execução com progresso`

* O executor é um worker persistente (`plan_runs`/`plan_steps`, migration 015):
  retoma após queda, resolve `ref`s quando o job bulk termina, cancela junto.
* **Guarda de reimportação**: identidade por `plan_id` ou sha256 do `plan.json`.
  Plano já aplicado → o app pausa, avisa a data e pergunta se o usuário tem
  certeza (`confirm_reapply`). Nunca duplica em silêncio, nunca bloqueia de vez.

---

## 2. Ponte MCP (controle por IA nesta máquina)

### Como funciona

* `sidecar/mcp.mjs` é um servidor MCP por **stdio** (JSON-RPC, sem dependências)
  que faz ponte para a API HTTP local do sidecar.
* Descoberta: com **"Permitir controle por IA (MCP)"** ligado (aba Planos & IA),
  o sidecar grava `%APPDATA%\isigroup\integration.json` (`{port, token}`) a cada
  arranque e o remove ao desligar/fechar. Só funciona com o app aberto, só nesta
  máquina, nada exposto na rede.
* **Aprovações**: toda ação de risco vira uma pendência (`pending_approvals`)
  exibida como banner no app; a ferramenta MCP aguarda a decisão (long-poll
  ~110 s; depois `wait_approval`). Pendências expiram em 10 min. Tudo vai para a
  trilha de auditoria (`integration_log`), visível na aba Planos & IA.
* Ações de escrita passam pelo **motor de planos** (plano de uma ação): mesmas
  validações, prévia (vira o resumo da aprovação) e limites da importação.

### Configuração (uma vez)

1. Abra o isigroup e ligue **Planos & IA → Permitir controle por IA (MCP)**.
2. Registre o servidor no Claude Code (o comando exato, com o caminho da sua
   instalação, aparece na própria aba com botão "Copiar"):

```
claude mcp add isigroup -- node "<pasta do app>\resources\sidecar\mcp.mjs"
```

(Em desenvolvimento: `claude mcp add isigroup -- node "<repo>\sidecar\mcp.mjs"`.)

### Prompt de uso (copiar e colar no Claude Code)

> O botão **"Copiar prompt de uso para o Claude Code"** na aba Planos & IA gera
> este texto já com o comando/caminho corretos da instalação.

```
Você tem acesso ao servidor MCP "isigroup", que controla o aplicativo isigroup
(agendamento e automação de grupos de WhatsApp) aberto NESTA máquina.

Se as ferramentas do isigroup não estiverem disponíveis, me instrua a: (1) abrir
o app isigroup; (2) ativar "Permitir controle por IA (MCP)" na aba Planos & IA;
(3) registrar o servidor rodando no terminal:
claude mcp add isigroup -- node "<caminho exibido no app>\mcp.mjs"
e então reiniciar esta sessão.

COMO OPERAR O ISIGROUP:
1. Comece com get_status (versão, edição, chips conectados). Antes de mexer com
   grupos, rode sync_groups e depois list_groups — grupos são endereçados por
   NOME, nos seletores {"names": ["Nome Exato"]} ou {"match": "padrão com *"}.
   Nunca invente jids.
2. Ferramentas de leitura (list_*, get_*) executam na hora. Ações de RISCO —
   create_groups, bulk_members, edit_groups, create_schedule, cancel_schedule,
   create_rule, update_rule, toggle_rule, delete_rule, apply_plan — abrem um
   pedido de aprovação DENTRO do app isigroup: me avise que a ação está
   aguardando minha aprovação lá; se a resposta vier com "pending", continue
   aguardando com wait_approval.
3. Para trabalhos com várias etapas dependentes (ex.: criar grupos e agendar
   mensagens NELES), não encadeie ferramentas soltas: leia get_plan_schema,
   monte um plano isiplan (a ação create_groups ganha um "id" e as demais usam
   {"ref": "id"}), confira com validate_plan, aplique com apply_plan e acompanhe
   com get_plan_run.
4. Telefones sempre com DDI+DDD, só dígitos (ex: 5511999998888). Datas de
   agendamento único em ISO 8601 com fuso (ex: 2026-10-01T09:00:00-03:00);
   recorrência usa recur_dow (0=domingo…6=sábado) + recur_time "HH:MM". Para
   mídia, use upload_media (base64) e passe o objeto retornado no campo "media"
   dos passos — áudio vira nota de voz automaticamente.
5. Antes de QUALQUER ação de escrita, me mostre um resumo claro do que vai fazer
   e em quais grupos. Nunca adicione membros em massa sem eu pedir
   explicitamente — é a ação com maior risco de banimento do chip. Respeite os
   limites do app (máx. 30 criações de grupo e 30 adições de membros por
   disparo; ritmo "slow" para volumes maiores).
6. Se apply_plan avisar que o plano já foi aplicado antes, me pergunte se tenho
   certeza antes de repetir com confirm_reapply=true.

Minha primeira tarefa: [descreva aqui o que você quer que a IA faça no isigroup]
```

### Ferramentas expostas (28)

| Grupo | Tools |
| --- | --- |
| Leitura | `get_status` `list_chips` `list_groups` `list_schedules` `get_schedule` `list_rules` `list_automation_logs` `list_bulk_jobs` `get_bulk_job` `list_selections` `list_plan_runs` `get_plan_run` `get_plan_schema` |
| Escrita leve (sem aprovação) | `sync_groups` `save_selection` `upload_media` `validate_plan` |
| Escrita de risco (**aprovação no app**) | `create_groups` `bulk_members` `edit_groups` `create_schedule` `cancel_schedule` `create_rule` `update_rule` `toggle_rule` `delete_rule` `apply_plan` |
| Utilitária | `wait_approval` |

---

## 3. Endpoints novos do sidecar

| Rota | Função |
| --- | --- |
| `POST /plans/validate` | corpo binário (zip/json) → staging + prévia + avisos + `already_applied` |
| `POST /plans/apply` | `{staged_id, confirm_reapply?}` → cria o run |
| `GET /plans/runs` · `GET /plans/runs/:id` · `POST /plans/runs/:id/cancel` | acompanhamento |
| `GET /plans/schema` | especificação oficial do formato |
| `GET/POST /integration` | status/toggle da ponte MCP (grava/remove `integration.json`) |
| `POST /integration/request` | ponte → cria pendência de aprovação |
| `GET /integration/approvals[?status=]` · `GET …/:id` · `GET …/:id/wait` · `POST …/:id/decide` | fila de aprovações |
| `GET /integration/log` | trilha de auditoria |
