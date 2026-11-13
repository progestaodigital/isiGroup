## Correções

### Agendamento no plano Free não dá mais "HTTP 403"
No plano Free, o campo de mídia aceitava vários arquivos na mesma mensagem (rodízio de mídias, recurso do plano Pro), e o agendamento era recusado ao salvar. Agora o plano Free aceita uma mídia por mensagem: escolher outra substitui a atual.

Agendamentos criados no plano Pro com várias mídias ou várias opções de mensagem também podem ser salvos no plano Free: o app avisa e mantém a 1ª opção e a 1ª mídia de cada mensagem.

Quando um agendamento for recusado, a mensagem de erro agora explica o motivo.
