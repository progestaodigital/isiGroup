# isigroup — Funcionalidades por plano

> Arquivo de contexto: o que o isigroup faz, o que está em cada plano, por que cada
> recurso existe e qual a vantagem dele para quem usa. Serve de base para suporte,
> material de venda, onboarding e para alimentar IAs que precisem falar do produto.
>
> Estado: versão **0.5.0** (outubro/2026).

---

## Em uma frase

O isigroup é um app para Windows que conecta seus números de WhatsApp e trabalha
pelos seus **grupos e comunidades**: agenda mensagens, reage sozinho a quem entra, sai
ou escreve, executa ações em lote e manda os eventos para o seu CRM.

## Os dois planos

| | **Plano normal (isigroup)** | **Plano Pro (isigroup-pro)** |
|---|---|---|
| Chips de WhatsApp | 1 | Ilimitados (com aviso a partir de ~5–6) |
| Proxy por chip | — | ✓ |
| Agendador (único, recorrente, sequência, todos os formatos) | ✓ | ✓ |
| Agendar em grupos onde é só membro | ✓ | ✓ |
| Automações e gatilhos | ✓ (só em grupos onde é admin) | ✓ (também onde é membro) |
| Webhook assinado | ✓ | ✓ (com identificação do chip) |
| Ações em massa | ✓ | ✓ |
| Seleções salvas, duplicar, semana par/ímpar, modo privacidade | ✓ | ✓ |
| Keymaker (variação de texto, rodízio de mídia, recorrente variável) | — | ✓ |
| Agentes de IA (respostas com base no seu conhecimento) | — | ✓ |
| Planos & IA (isiplan + controle por IA via MCP) | — | ✓ |
| Exportar configuração para outro computador | — | ✓ |

O plano é definido pela licença no momento em que o app abre. Os bloqueios do Pro
valem **dentro do motor do app**, não só na tela: nenhum caminho alternativo (plano
importado, IA via MCP) libera recurso Pro numa licença normal.

---

## Princípios que valem para os dois planos

Estes pontos explicam várias decisões abaixo e devem aparecer em qualquer comunicação
sobre o produto.

- **Conexão não oficial.** O isigroup conecta como um "Aparelho conectado" (igual ao
  WhatsApp Web) usando uma biblioteca não oficial. Isso viola os Termos do WhatsApp e
  existe risco de banimento do número. Recomendação fixa: usar um **número secundário
  dedicado**, nunca o principal.
- **Ritmo anti-flood, não evasão.** O app espaça os envios para não inundar o
  WhatsApp e respeitar limites de taxa. Nenhum recurso existe para enganar a detecção
  (sem caractere invisível, sem letra disfarçada, sem rotação para mascarar).
- **Trabalha só com o que o número já participa.** O app nunca faz um chip entrar em
  grupo por conta própria.
- **Seus dados ficam no seu computador.** Fila, regras e histórico ficam num banco
  local. Conversas privadas não são armazenadas. A chave da licença e a chave da
  OpenAI ficam no cofre do Windows, nunca em arquivo de texto.

---

# Plano normal

## Conexão e grupos

### Conexão por QR com sessão salva
**O que é:** você escaneia o QR uma vez e o app guarda a sessão. Ao abrir de novo, ele
reconecta sozinho.
**Por que existe:** escanear QR a cada uso seria inviável para uma ferramenta que
precisa ficar ligada disparando agendamentos.
**Vantagem:** liga e esquece. Se a conexão cair (suspensão do PC, troca de Wi-Fi), o
app tenta de novo com intervalos crescentes e, depois, uma vez por minuto
indefinidamente, até voltar. Ele só para e pede QR novo se o próprio WhatsApp
desconectar a sessão.

### Sincronização de grupos e comunidades
**O que é:** o app lista todos os grupos, comunidades e grupos de avisos da conta,
marcando onde você é admin e quais grupos só aceitam mensagem de admin.
**Por que existe:** tudo no app (agendar, automatizar, ações em lote) parte de "em quais
grupos". A lista precisa ser fiel ao que existe no WhatsApp.
**Vantagem:** a lista se mantém limpa. Grupos de que você saiu somem; se você trocar o
número de um chip, os grupos do número antigo são apagados na hora. Um retorno vazio
do WhatsApp (falha momentânea) nunca apaga sua lista.

### Seletor de grupos com busca e seleções salvas
**O que é:** busca por nome, marcar/desmarcar todos e salvar conjuntos de grupos com um
nome ("Turmas 2026", "Clientes VIP") para reaplicar com um clique.
**Por que existe:** quem opera dezenas ou centenas de grupos repete sempre as mesmas
combinações.
**Vantagem:** monta o público de um envio em segundos e sem esquecer grupo.

## Agendador

### Disparo único
**O que é:** uma mensagem (ou sequência) para vários grupos, numa data e hora.
**Por que existe:** é a base do produto: avisar no horário certo sem precisar estar
online.
**Vantagem:** a fila fica salva em disco. Se o app reiniciar, o agendamento continua
valendo e dispara no horário (o app precisa estar aberto e conectado nessa hora).

### Recorrente semanal
**O que é:** repete toda semana, num dia e horário fixos.
**Por que existe:** avisos de rotina (aula de segunda, live de quinta, lembrete de
pagamento) se repetem.
**Vantagem:** configura uma vez. Se o chip ou o app cair no meio de um disparo, ele
retoma do ponto onde parou quando a conexão volta, sem reenviar o que já saiu.

### Semana par / ímpar
**O que é:** filtro opcional no recorrente para disparar só em semanas pares ou ímpares
(mesma numeração do Google Agenda), com prévia dos próximos envios.
**Por que existe:** muita rotina é quinzenal.
**Vantagem:** resolve o "a cada 15 dias" sem criar e apagar agendamentos na mão.

### Sequência de mensagens
**O que é:** várias mensagens em ordem, com intervalo configurável entre elas. Cada
grupo recebe a sequência inteira antes de o app passar ao próximo grupo.
**Por que existe:** comunicação real raramente é uma mensagem só (texto + áudio +
imagem do material, por exemplo).
**Vantagem:** a sequência chega coesa em cada grupo, sem ficar espalhada por minutos
porque o app estava atendendo os outros grupos.

### Todos os formatos
**O que é:** texto, imagem, vídeo, enquete e **áudio como nota de voz** (com a
"ondinha" de verdade). Texto ganha prévia de link (imagem, título, descrição).
**Por que existe:** formato muda engajamento. Nota de voz, em particular, parece
gravada na hora.
**Vantagem:** você envia qualquer arquivo de áudio e o app converte sozinho para o
formato de nota de voz que o WhatsApp exige.

### Menção oculta de todos (@all)
**O que é:** notifica todos os membros do grupo sem encher o texto de @nomes.
**Por que existe:** avisos importantes precisam de atenção de todos.
**Vantagem:** a mensagem fica limpa e todos são notificados. Deve ser usado com
moderação: é um dos padrões que mais incomodam e mais chamam atenção do WhatsApp.

### Agendar em grupos onde você é só membro
**O que é:** o agendador também lista os grupos em que a conta não é admin, marcados
como "(membro)".
**Por que existe:** muita gente divulga em grupos de terceiros dos quais participa.
**Vantagem:** um só lugar para todos os envios. Em grupos onde só admin pode falar, o
envio de membro falha e aparece como "falhou" no status.

### Editar, duplicar e histórico por grupo
**O que é:** edição completa de qualquer agendamento, botão Duplicar (cria cópia com
"(cópia)" no título, original intacto) e status de envio grupo a grupo.
**Por que existe:** campanhas parecidas se repetem e erros precisam ser corrigidos sem
recomeçar.
**Vantagem:** reaproveita o trabalho e mostra exatamente em qual grupo algo falhou e
por quê.

### Confiabilidade do disparo
**O que é:** espaçamento levemente aleatório entre grupos, nova tentativa automática em
erro passageiro e grupos impossíveis de atender marcados como "pulados", não como
falha.
**Por que existe:** um erro num grupo não pode travar a fila nem gerar falha semanal
recorrente.
**Vantagem:** o disparo termina mesmo quando algo dá errado no meio, e o relatório
mostra a causa.

## Automações e gatilhos

### Gatilhos
**O que é:** a regra dispara quando alguém **entra** no grupo, **sai** do grupo, **envia
uma mensagem** (que começa com, contém, termina com ou é exatamente um texto) ou envia
uma mensagem **com link**.
**Por que existe:** boa parte do trabalho de quem administra grupo é reagir: dar
boas-vindas, barrar divulgação, registrar quem saiu.
**Vantagem:** o grupo é moderado 24 horas sem ninguém olhando.

### Ações combináveis
**O que é:** cada regra executa uma ou mais ações, em ordem, com intervalo variável
entre elas:
- **mensagem no grupo** e **mensagem no privado** de quem disparou, com os mesmos
  formatos e sequências do agendador;
- **remover do grupo**;
- **apagar a mensagem** que disparou o gatilho (só em gatilhos de mensagem);
- **webhook** para o seu sistema.

**Por que existe:** a mesma situação pede mais de uma resposta (ex.: link de spam →
apagar a mensagem, remover o autor, avisar o CRM).
**Vantagem:** monta um fluxo completo numa regra só. Há uma trava fixa: **admin nunca é
removido** por automação, mesmo com regra mal configurada.

**Limite do plano normal:** automações funcionam **só em grupos onde a conta é admin**.

### Webhook assinado
**O que é:** a cada evento o app envia um JSON para uma URL sua, com grupo, lead (nome,
telefone, id), mensagem, data e hora. A chave vai em `x-api-key` e
`Authorization: Bearer`, mais uma assinatura HMAC-SHA256 para conferir a origem.
Falhas são reenviadas com espera crescente.
**Por que existe:** o isigroup observa e emite. Decidir o que fazer com o lead (CRM,
funil, planilha) é trabalho de outra ferramenta.
**Vantagem:** integra direto com isiFlow, n8n, Make e Zapier. O telefone real de quem
entra ou sai vem no payload, mesmo com o WhatsApp escondendo números por trás de ids
de privacidade.

### Histórico das automações
**O que é:** log de cada execução: regra, grupo, quem disparou, o que foi feito.
**Por que existe:** automação que age sozinha precisa ser auditável.
**Vantagem:** quando alguém reclama de ter sido removido, você sabe qual regra fez isso
e quando.

## Ações em massa

**O que é:** operações em lote sobre membros e grupos:
- **adicionar, remover, promover a admin e rebaixar** membros a partir de uma lista de
  telefones colada ou importada;
- **editar vários grupos de uma vez**: nome, descrição, imagem e configurações (quem
  envia, quem edita, aprovação de entrada);
- **criar grupos em série**.

Tudo pode ser agendado, com ritmo escolhido (lento, médio, rápido), progresso ao vivo,
cancelamento e edição enquanto está agendado. Edições de grupo podem ser
**recorrentes** (semanal, com semana par/ímpar).

**Por que existe:** abrir 40 grupos um a um para trocar a descrição, ou adicionar 200
alunos na mão, toma horas e induz a erro.
**Vantagem:** o que levava uma tarde vira um formulário. Os limites anti-banimento
(30 criações ou 30 adições por disparo, ritmo aleatório) já vêm embutidos. A
recorrência só é permitida para edição de grupo: readicionar as mesmas pessoas toda
semana seria risco de banimento.

## Conforto e operação

### Modo privacidade
**O que é:** um botão na Visão geral que borra telefones, nomes de leads, nomes de
grupos, seu próprio número, credenciais e proxy em todas as telas. Passar o mouse
revela.
**Por que existe:** quem grava tutorial, faz live ou compartilha a tela expõe dados de
clientes sem perceber.
**Vantagem:** pode mostrar o app sem vazar dados de ninguém.

### Atualização automática assinada
**O que é:** o app avisa quando há versão nova, mostra o que mudou, baixa, instala e
reinicia. O instalador é verificado por assinatura digital antes de instalar.
**Por que existe:** correções (especialmente de conexão, que muda conforme o WhatsApp
muda) precisam chegar rápido.
**Vantagem:** um clique para ficar em dia, sem risco de instalar arquivo adulterado.

### FAQ e suporte embutidos
**O que é:** perguntas frequentes focadas em risco de banimento e boas práticas, e chat
de atendimento dentro do próprio app.
**Por que existe:** a maior dúvida de quem usa automação de WhatsApp é "vou ser
banido?". A resposta precisa estar à mão.
**Vantagem:** orientação honesta e suporte sem sair do app.

---

# Plano Pro

Tudo do plano normal, mais:

## Multi-chip

### Vários chips conectados
**O que é:** conectar quantos números quiser, cada um com seu QR, status, rótulo e
sessão independente.
**Por que existe:** operações maiores dividem os grupos entre vários números (por
equipe, por produto, ou porque um número só não cabe em todos os grupos).
**Vantagem:** um painel só para todos os números. Conectar ou cair um chip não afeta os
outros.

### Proxy por chip
**O que é:** cada chip pode sair por um proxy próprio (SOCKS5 ou HTTP/HTTPS), com botão
de teste que mostra o IP de saída.
**Por que existe:** vários números saindo do mesmo computador compartilham a mesma
conexão de internet.
**Vantagem:** cada número com sua própria rota de rede, configurável e testável na
tela.

### Disparo por grupo com cobertura e rodízio
**O que é:** você escolhe os grupos primeiro; o app mostra quais chips são membros de
cada um ("cobre X de Y"). No disparo, cada grupo recebe por **um** chip que já está
nele, revezando entre os chips. Grupos onde só admin fala vão só por chip admin.
Grupos sem nenhum chip selecionado são pulados e avisados antes de salvar.
**Por que existe:** com vários números, alguém precisa decidir "qual número manda em
qual grupo". Fazer isso na mão não escala.
**Vantagem:** a carga se distribui sozinha entre os números, nenhum grupo recebe a
mensagem duplicada e você sabe antes do envio quais grupos ficariam de fora.

### Automações multi-chip sem duplicar
**O que é:** com vários chips no mesmo grupo, o evento é visto por todos, mas a regra
dispara **uma vez** e só um chip responde. Remoções usam um chip admin.
**Por que existe:** sem isso, 3 chips num grupo dariam 3 boas-vindas para cada pessoa
que entra.
**Vantagem:** escala o número de chips sem bagunçar a experiência de quem está no
grupo. Logs e webhooks indicam qual chip agiu.

## Automação em grupos onde é só membro
**O que é:** no Pro, regras também valem em grupos onde a conta não é admin.
**Por que existe:** quem participa de grupos de terceiros também quer responder a
perguntas, registrar leads e mandar DM para quem pede algo.
**Vantagem:** mensagens e webhooks funcionam em qualquer grupo da conta. Ações que
exigem admin (remover, apagar mensagem) continuam falhando onde você não é admin.

## Keymaker — variação de mensagem

Três recursos sobre o mesmo motor de sorteio. Em todos, o sorteio evita repetição
enquanto houver combinação nova. É variação de texto para a comunicação não soar
robótica e para testar mensagens, não truque para burlar detecção.

### Variação de texto (spintax) e variáveis
**O que é:** escreva alternativas entre chaves, separadas por barra:
`{{Oi, tudo bem?|Olá, como vai?|Opa!}}`. Cada grupo recebe uma. Blocos se multiplicam
(3 × 4 = 12 combinações) e podem ser aninhados. A tela mostra o total de combinações e
sorteia exemplos para conferir. Variáveis de contexto: `{{grupo}}`, `{{chip}}`,
`{{saudacao}}` (bom dia/boa tarde/boa noite), `{{data}}`, `{{hora}}` e, em automações,
`{{nome}}` e `{{primeiro_nome}}` de quem disparou.
**Por que existe:** a mesma mensagem idêntica em 50 grupos parece spam e cansa quem
participa de vários deles.
**Vantagem:** mensagens personalizadas ("Bom dia, Ana! Bem-vinda ao Turma 12") sem
escrever 50 versões. Funciona em texto, legenda e enquete, no agendador e nas
automações. Texto comum com chaves (`{{R$ 100}}`) sai como foi escrito; template
quebrado é recusado ao salvar.

### Rodízio de mídia
**O que é:** até 10 arquivos (imagem, áudio ou vídeo) numa mesma mensagem; cada grupo
recebe um. Legenda e arquivo são sorteados de forma independente (2 legendas × 4
imagens = 8 combinações).
**Por que existe:** mesma lógica do texto: criativos diferentes rendem mais e cansam
menos.
**Vantagem:** testa criativos e varia a apresentação sem criar um agendamento por
imagem. Se um arquivo for apagado do computador, o app usa outro da lista em vez de
falhar o envio.

### Recorrente variável
**O que é:** um agendamento semanal com várias **opções** de mensagem para o mesmo dia e
horário. A cada disparo sai uma opção, e no seguinte, outra. Todas aparecem antes de
repetir. Cada opção é uma sequência completa (formatos, mídias, variações). Botão
duplicar para criar uma opção a partir de outra.
**Por que existe:** o aviso semanal idêntico vira ruído; o grupo para de ler.
**Vantagem:** a rotina fica sempre com cara de nova sem você reescrever toda semana. Se
o app cair no meio do disparo, ele retoma com a **mesma** opção: ninguém recebe meia
mensagem de uma e meia de outra.

> Se a licença voltar ao plano normal, agendamentos com variação continuam salvando e
> disparando: o app envia sempre a primeira variação, sem nunca mandar as chaves cruas.

## Agentes de IA
**O que é:** assistentes que respondem perguntas nos grupos **usando só o conhecimento
que você cadastrar** (texto, .txt, .md, .pdf, .docx ou URL). Você escolhe onde e quando
respondem: ao mencionar o chip, por gatilho de texto ou em toda mensagem. Com vários
agentes, uma **triagem** escolhe quem responde (primeiro por palavra-chave, depois pela
descrição de cada agente) e, se o primeiro não souber, passa ao próximo, com limite de
tentativas. Usa a sua chave da OpenAI, guardada no cofre do Windows.
**Por que existe:** grupos de alunos, clientes e comunidades repetem as mesmas
perguntas ("cadê o link?", "como emito a 2ª via?") o dia inteiro.
**Vantagem:** resposta imediata e fiel ao seu material, sem inventar: se a pergunta não
tem base no conhecimento cadastrado, o agente não responde. Há travas de custo
(intervalo mínimo por grupo, uma resposta por pergunta mesmo com vários chips, chips
não respondem uns aos outros) e um painel das últimas perguntas para você ajustar o
conhecimento. Endereços da rede local são recusados ao importar URL, por segurança.

## Planos & IA

### Planos de ação (isiplan)
**O que é:** um arquivo (JSON ou pacote .isiplan com mídias) que descreve uma operação
inteira: criar grupos, adicionar membros, editar grupos, agendar mensagens, criar
regras de automação, salvar seleções. Pode ser gerado por qualquer IA (ChatGPT,
Claude…) em qualquer máquina. No app você importa, revisa a prévia e confirma.
**Por que existe:** montar um lançamento ou uma nova turma envolve dezenas de cliques
em várias telas. Descrever em texto e deixar a IA montar o plano é mais rápido.
**Vantagem:** "crie 3 grupos da Turma 10 a 12, agende o aviso de segunda e dê
boas-vindas a quem entrar" vira um arquivo aplicado de uma vez. Grupos são
referenciados por nome, nunca por id interno, então o plano funciona em qualquer
computador. Nada executa sem sua confirmação, e os limites anti-banimento valem
igual. Reimportar o mesmo plano pede confirmação.

### Controle por IA local (MCP)
**O que é:** uma ponte que deixa uma IA instalada no mesmo computador (ex.: Claude
Code) operar o isigroup ao vivo. Liga e desliga na aba Planos & IA. Ações de risco
geram um pedido de aprovação que aparece numa faixa no topo do app.
**Por que existe:** para quem já trabalha com assistente de IA, conversar ("agende isso
para os grupos de vendas na sexta") é mais rápido que navegar telas.
**Vantagem:** operação por conversa, com você aprovando o que importa.

## Exportar configuração
**O que é:** gera um pacote com agendamentos, automações, agentes de IA, ações em massa
recorrentes, seleções salvas e configuração dos chips, para importar em outro
computador. Você escolhe as seções e se leva os segredos de webhook (desmarcado por
padrão).
**Por que existe:** troca de computador, backup e replicar a mesma estrutura para outro
cliente ou outra máquina.
**Vantagem:** migra tudo em minutos. O pacote é um plano isiplan comum, então passa
pela mesma revisão de qualquer importação. A sessão do WhatsApp, a chave da licença e
a chave da OpenAI **nunca** saem no arquivo; no destino, os chips conectam por QR.

---

## Resumo para quem está decidindo

- **Plano normal** é para quem administra os próprios grupos com **um número**:
  agenda tudo, automatiza boas-vindas e moderação, integra com o CRM e faz operações
  em lote.
- **Plano Pro** é para quem opera em escala ou quer IA no processo: **vários números**
  com distribuição automática, automação também em grupos onde é só membro, mensagens
  que variam sozinhas, agentes que respondem dúvidas e operação por IA via planos e
  MCP.
