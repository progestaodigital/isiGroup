## isiGroup v0.1.14

### Correção definitiva do chip que não gerava o QR
Alguns usuários ficavam presos em "Estabelecendo conexão…" e o QR nunca aparecia. A causa: em redes que bloqueiam o GitHub (firewall/antivírus/provedor), o app não conseguia obter a versão atual do WhatsApp Web e caía numa versão antiga que o WhatsApp **recusa** — sem gerar QR.

- **Versão do WhatsApp Web conhecida-boa embutida no app** como reserva, usada quando não dá para buscar a atual — o pareamento funciona mesmo sem acesso ao GitHub.
- **Memoriza a última versão que funcionou** e a reutiliza nas próximas aberturas.
- **Busca de versão com tempo limite** — nunca mais trava o início da conexão.
- **Fim do "conectando" infinito e mudo** — após algumas tentativas sem sucesso, o app para e mostra o motivo ("verifique internet, firewall ou antivírus").
- **Sessão corrompida se recupera sozinha** — em vez de reusar credenciais quebradas, o chip limpa e pede um QR novo.

### Licença estável ao fechar e reabrir
Corrige a licença que "deixava de ser reconhecida" depois de fechar e abrir o programa (exigindo resetar o HWID toda hora).

- **Identificação da máquina agora é fixada** na primeira leitura válida e reutilizada nas próximas aberturas — variações momentâneas na leitura do hardware não invalidam mais a licença.
- Guardada de forma segura no cofre do sistema (atrelada à máquina), sem enfraquecer o vínculo por computador.
- Trocar/desativar a licença re-detecta o hardware no próximo arranque (para troca real de máquina).
