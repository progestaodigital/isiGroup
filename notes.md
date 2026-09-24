## isiGroup v0.2.0

### Agendamento por semana par ou ímpar
Agora o agendamento recorrente aceita, **opcionalmente**, filtrar pela semana do ano — dá para marcar "toda segunda de semanas ímpares" em vez de toda segunda.

- Na criação de um recorrente, entre o dia da semana e o horário, escolha **Todas as semanas** (padrão), **Só semanas ímpares** ou **Só semanas pares**.
- O campo é opcional: quem não mexer continua com o comportamento de sempre, e os agendamentos já existentes não mudam.
- A tela mostra em que semana você está e as **próximas datas de envio**, para não haver dúvida na hora de escolher.
- A numeração da semana é a **ISO-8601 — a mesma que o Google Agenda exibe**.
- Atenção: alguns anos têm 53 semanas (2026 é um deles). Nesses anos, a semana 53 e a semana 1 do ano seguinte são ambas ímpares, então um agendamento de semanas ímpares dispara em duas semanas seguidas na virada. O app avisa isso na própria tela.

### Planos & IA: uma IA pode montar sua operação
Nova aba **Planos & IA**, com dois caminhos — e **nenhum deles executa nada sem a sua confirmação**.

- **Importar plano:** uma IA em qualquer computador gera um arquivo de plano (criar grupos, agendar mensagens, montar automações) e você importa no app. Antes de aplicar, você vê a **prévia completa** do que será feito e confirma.
- **Ponte com IA nesta máquina:** ligando o interruptor da aba, uma IA instalada no seu computador passa a operar o app ao vivo. Ações de risco (adicionar membros, remover, editar grupos) param num **pedido de aprovação** dentro do app, com um aviso no topo da tela.
- Os limites anti-banimento continuam valendo do mesmo jeito: 30 criações e 30 adições por disparo, com ritmo aleatório. O plano não passa por cima disso — ele usa as mesmas filas do app.
- Planos referenciam grupos por **nome ou por grupos criados no próprio plano**, nunca por identificadores internos.
- Reimportar um plano já aplicado pede confirmação extra, para não duplicar sem querer.

### Ações em massa e conexão
- Melhorias no processamento das ações em massa e na estabilidade da conexão dos chips.
