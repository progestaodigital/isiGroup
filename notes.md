## isiGroup v0.1.15

### Sequência de mensagens agora é enviada completa em cada grupo
Antes, ao agendar uma sequência (ex.: vídeo → imagem → áudio), o app enviava a **primeira mensagem para todos os grupos**, depois voltava e enviava a segunda para todos, e assim por diante — nos grupos, a sequência chegava "picada" e demorava mais para completar quanto mais grupos estivessem selecionados.

- **Agora cada grupo recebe a sequência inteira, na ordem, antes de o envio passar ao próximo grupo.**
- O **intervalo entre mensagens** que você configura vale dentro do mesmo grupo — exatamente como aparece na tela.
- Entre um grupo e outro, o app mantém o espaçamento automático anti-flood.
- Se uma mensagem falhar num grupo, a sequência daquele grupo é interrompida (nada de sequência pela metade fora de ordem) e o envio segue normalmente para os demais grupos.
- Se a conexão cair no meio, cada grupo retoma do ponto exato onde parou — sem repetir mensagens já enviadas.
