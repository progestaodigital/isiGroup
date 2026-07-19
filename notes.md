## isiGroup v0.1.10

### Envios recorrentes muito mais confiáveis
- **Grupos sem cobertura não geram mais falha** — alvos que nenhum chip selecionado cobre agora são pulados sem tentativa de envio (e voltam a enviar sozinhos se um chip passar a cobrir o grupo).
- **Rodízio ciente de admin** — em grupos "só admins enviam" (incluindo avisos de comunidade), o envio é roteado para um chip **admin**; sem nenhum admin disponível, o alvo é pulado em vez de falhar toda semana. Requer uma sincronização dos grupos para valer em grupos comuns com "só admins".
- **Retomada no mesmo dia** — se a conexão (ou o app) cair no meio de um disparo recorrente, os grupos que ficaram pendentes são enviados automaticamente assim que a conexão voltar, sem duplicar o que já foi enviado (sequências continuam do passo onde pararam).
- **Re-tentativa automática** — erros transitórios do WhatsApp (timeout, limite de taxa) ganham uma segunda tentativa antes de marcar falha.

### Interface
- **Selects legíveis** — as opções dos menus suspensos (dia da semana, reagendar, automação) agora aparecem em texto escuro sobre fundo claro, em vez de cinza sobre branco.
