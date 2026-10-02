# Keymaker — variação de mensagem, rodízio de mídia e recorrente variável

> Recursos do plano **Pro**, com gate **no motor** (não só na UI) — a ponte MCP e o
> executor de planos batem nas rotas direto.

Três recursos que compartilham o mesmo motor de sorteio (`sidecar/src/spin.mjs`):

| Recurso | O que varia | Granularidade do sorteio |
|---|---|---|
| **Spintax** | o texto dentro de uma mensagem | um sorteio **por grupo** |
| **Rodízio de mídia** | qual arquivo acompanha a mensagem | um sorteio **por grupo** |
| **Recorrente variável** | qual mensagem inteira é enviada | um sorteio **por disparo** |

Em todos, o sorteio é **sem repetição**: enquanto houver combinação nova, dois grupos
do mesmo disparo não recebem a mesma coisa, e dois disparos seguidos não repetem a
mesma opção.

Isto é variação de copy — naturalidade e teste de mensagem. **Não há nada aqui para
evadir detecção**: sem caractere invisível, sem homoglifo. O pacing anti-flood do
scheduler continua sendo o único mecanismo de ritmo.

---

## 1. Sintaxe

```
{{oi, tudo bem?|olá, como vai?|opa, tudo bem com você?}}

{{Fabio Aleixo aqui|Fabio Aleixo falando|aqui é o Fabio Aleixo}}, do {{grupo}}
```

Três variações × três variações = **9 combinações**. Cada bloco multiplica.

Blocos **aninham**: `{{oi {{amigo|parceiro}}|olá}}` = 3 combinações.

### Variáveis de contexto

Variável é um **bloco de nome reservado** — mesmo delimitador, mesmo parser:

| Variável | Valor | Onde existe |
|---|---|---|
| `{{grupo}}` | nome do grupo | agendamento + automação |
| `{{nome}}` | nome de quem disparou o gatilho | **só automação** |
| `{{primeiro_nome}}` | primeira palavra de `{{nome}}` | **só automação** |
| `{{chip}}` | rótulo da conta que envia | agendamento + automação |
| `{{saudacao}}` | bom dia / boa tarde / boa noite (hora local) | ambos |
| `{{data}}` | `DD/MM/AAAA` | ambos |
| `{{hora}}` | `HH:MM` | ambos |

Variável que não existe no contexto resolve **vazia** e come um espaço vizinho:
`Olá {{nome}}, tudo bem?` num broadcast sai `Olá, tudo bem?`. A tela avisa ao salvar.

Variável e spintax se compõem nas duas direções:
`{{Oi {{primeiro_nome}}|{{saudacao}}, {{primeiro_nome}}}}`.

### As duas regras que protegem texto comum

Pipe e chave aparecem em mensagem normal, então:

1. **Sem `{{` no texto, nada é interpretado.** Caminho rápido: a mensagem volta
   byte a byte idêntica — sem parse, sem unescape, sem trim, sem colapso de
   espaço. Toda mensagem salva antes do Keymaker sai exatamente como antes.
   (Consequência: escape `\{` só é processado em texto que tem algum bloco.)
2. **`{{...}}` só é bloco se tiver pipe ou for variável reservada.** `{{R$ 100}}`
   sai **literal**. Sem essa regra, chave acidental em texto legado — ou vinda de
   um plano/MCP — seria mastigada em silêncio. A tela avisa que vai sair literal.

| Entrada | Resultado |
|---|---|
| `Plano A \| Plano B` | literal |
| `{ x }`, `}` sozinho, `}}` solto | literal |
| `{{R$ 100}}` | literal + aviso |
| `{{a\|b}}` | bloco de 2 |
| `{{grupo}}` | variável |
| `{{a\|b` (não fecha) | **erro ao salvar**, literal no disparo |

Escapes: `\{` `\}` `\|` `\\`.

### Estrito na porta, tolerante no disparo

- **Ao salvar** (rota `/schedules`, regras, importação de plano): bloco sem fechar
  é **recusado**, com a mensagem do erro. Você está na tela e corrige.
- **No disparo**: o mesmo texto **passa literal**. `render()` nunca lança. Quem
  salva é uma pessoa olhando a tela; quem dispara é um worker às 3 da manhã, e lá
  falhar fechado é melhor que travar a fila.

Na edição **free** o motor continua resolvendo, com o **índice 0** (primeira
variação): um plano importado via MCP numa licença free não despeja chaves num grupo.

---

## 2. Rodízio de mídia

Até **10 arquivos** por mensagem. O app alterna entre eles, um sorteio por grupo.
Mídia é só outro bloco de variação: **2 legendas × 4 imagens = 8 combinações**.

Legenda e mídia sorteiam **independente** (imagem 2 pode cair com a legenda 5).

- Todas as mídias de uma mensagem compartilham o **tipo** dela (4 imagens, ou 4
  vídeos, ou 4 áudios).
- Áudio PTT carrega **waveform, duração e mimetype por arquivo** — é por isso que a
  mídia virou tabela filha e não colunas do passo.
- **Arquivo sumiu do disco?** O app re-sorteia entre os restantes. Só falha se todos
  sumirem. Antes, mídia ausente fazia o envio falhar.
- Memória: leitura sob demanda com cache de **~128 MB** (`mediapool.mjs`). Imagem
  fica em cache; vídeo grande é relido do disco a cada envio.

---

## 3. Recorrente variável

Várias opções de mensagem para o mesmo dia e horário. O app escolhe **uma** por
disparo e, no seguinte, uma **diferente**. Cada opção é uma sequência completa —
formatos, mídias, spintax, tudo.

Na tela: terceiro tipo de disparo, com **abas de opção**. Grupos e chips ficam fora
das abas (são do agendamento, não da opção). O botão **duplicar** existe porque o
caso real é "5 variações da mesma promoção", não 5 mensagens do zero.

Dois modos: **sortear sem repetir** (padrão) ou **em ordem** (1, 2, 3…).

### A armadilha que define o desenho

O recorrente **re-arma a mesma linha** do banco, e tem **retomada no mesmo dia**: se
o app cair no meio do disparo, ele volta e continua pelos grupos que faltaram.

Então a opção sorteada **gruda no dia**. O sorteio acontece dentro da transação que
já marca `last_run_at`/`recur_fired_at` e repõe os alvos, gravando `variant_current`.
A retomada **lê** esse valor em vez de sortear.

Se sorteasse de novo, o mesmo disparo sairia partido em duas mensagens diferentes — e
pior: `seq_step` (o passo em que cada grupo parou) indexa os passos *daquela* opção,
então o índice apontaria para o passo de outra.

### Casos-limite cobertos

- **1 opção** → idêntico ao recorrente de sempre.
- **Opções com nº de passos diferente** → coberto pelo sticky; `seq_step` nunca cruza opções.
- **Usuário apagou uma opção** entre disparos → o total é recontado no banco e os
  índices fora de faixa são saneados; opção inexistente cai na opção 1 e loga.
- **Recorrência semanal** → o baralho das opções é **persistido**, então a semana
  seguinte não repete. Os baralhos de texto/mídia vivem **por execução**: numa
  retomada pós-crash eles reembaralham (a *opção* é estável, o texto dentro dela não).

---

## Onde isso vive no código

| Arquivo | Papel |
|---|---|
| `sidecar/src/spin.mjs` | motor: parse, contagem, render por índice, baralhos, `applySpin` |
| `sidecar/src/spin.test.mjs` | 41 testes (`node --test`) |
| `sidecar/src/mediapool.mjs` | cache de mídia com orçamento de bytes |
| `sidecar/src/scheduler.mjs` | render **por alvo** + rodízio + sorteio da opção na transação do dia |
| `sidecar/src/automation.mjs` | render por disparo; baralhos vivem **entre eventos** |
| `sidecar/index.mjs` | `POST /spin/preview`, validação ao salvar, gate Pro, gravação |
| `src/components/StepEditor.tsx` | `KeymakerText` (contador, exemplos, atalhos) + lista de mídias |
| `src/components/SchedulerView.tsx` | abas de opção + terceiro tipo de disparo |
| `migrations/019_media_variants.sql` | `schedule_step_media` + `media_assets.order_index` |
| `migrations/020_recurring_variants.sql` | `variant_*` em `schedules` + `option_index` no passo |

### Detalhes de implementação que não são óbvios

- **Render por índice (radix misto).** `renderAt(t, i)` devolve a combinação nº *i*
  sem enumerar as outras: 10¹² combinações custam o mesmo que 12. É o que permite o
  contador exato e o sorteio sem repetição.
- **O refactor que o K1 exigiu.** O conteúdo da sequência era montado **uma vez** e
  reusado em todos os grupos (para não reler mídia do disco). A leitura de disco
  continua acontecendo uma vez por arquivo (no cache), mas o **texto** passou a ser
  montado dentro do loop de alvos.
- **Dual-write da mídia.** A mídia 0 vai também para as colunas `media_*` do passo.
  O auto-updater permite voltar para uma versão anterior, e sem isso um agendamento
  criado agora apareceria sem mídia lá.
- **FK da tabela filha.** Com `PRAGMA foreign_keys = ON`, apagar um passo com mídias
  referenciando-o falha a transação — `schedule_step_media` sai **antes** de
  `schedule_steps`, em `updateSchedule` e `deleteSchedule`.
- **Enquete.** Opções sorteadas são garantidamente **distintas** (o WhatsApp exige):
  re-sorteia até 8 vezes e, no limite, usa a primeira variação de cada e deduplica.
- **Guardas do parser.** Posição que já falhou como início de bloco é memoizada e
  não é re-tentada, e sem `}}` adiante o bloco é rejeitado em O(1) — sem isso,
  `"{{"` repetido 200× virava backtracking exponencial. Há também um orçamento de
  trabalho que aborta o parse (quem chama trata como texto literal).
- **Teto dos baralhos.** Acima de 4096 combinações o baralho não rastreia o que já
  saiu: na automação ele vive entre eventos, e com 10¹² combinações o conjunto de
  usados cresceria um item por disparo.

---

## Limites

| | |
|---|---|
| Variações por bloco | 50 |
| Aninhamento | 5 níveis |
| Tamanho do template | 10.000 caracteres |
| Combinações | 10¹² (acima disso a aritmética de índice perde exatidão) |
| Mídias por mensagem | 10 |
| Opções de mensagem | 10 |

---

## Plano declarativo (isiplan) e MCP

Tudo passa pelas mesmas rotas, então o plano JSON e a ponte MCP aceitam:

```json
{
  "type": "schedule",
  "params": {
    "targets": { "match": "Turma *" },
    "kind": "recurring", "recur_dow": 1, "recur_time": "09:00",
    "variant_mode": "random",
    "options": [
      { "steps": [{ "type": "text", "text": "{{Bom dia|Oi}}, {{grupo}}! Promo A" }] },
      { "steps": [{ "type": "image",
                    "medias": [{ "file": "media/a.png" }, { "file": "media/b.png" }],
                    "text": "Promo {{de hoje|da semana}}" }] }
    ]
  }
}
```

`medias[]` no lugar de `media`; `options[]` no lugar de `steps`. As formas antigas
continuam aceitas, e o **exportador** emite as novas só quando há mais de uma
variação — exportar/importar não descarta nada.

---

## Como verificar

```bash
cd sidecar
node --test src/spin.test.mjs   # 41 testes do motor (sem dependência nova)
node smoke/routes.mjs           # 25 checagens: migrations, rotas, gravação, gate Pro
node smoke/dispatch.mjs         # 15 checagens: disparo real por grupo (wa falso)
node smoke/automation.mjs       # 8 checagens: gatilho real, variáveis, rodízio
```

Os três smokes sobem um DB temporário e não tocam nada do app instalado. O
`dispatch.mjs` é o que prova o contrato de verdade: texto sem spintax sai idêntico
para todos, com spintax sai distinto por grupo, a moldura fixa das mistas fica
intacta, a mídia alterna, a opção gruda no dia e a free usa sempre a primeira.
