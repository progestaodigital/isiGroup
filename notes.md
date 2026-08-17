## isiGroup v0.1.13

### Licença estável ao fechar e reabrir
Corrige o caso em que a licença "deixava de ser reconhecida" depois de fechar e abrir o programa (exigindo resetar o HWID toda hora).

- **Identificação da máquina agora é fixada** na primeira leitura válida e reutilizada nas próximas aberturas — variações momentâneas na leitura do hardware não mudam mais a identidade nem invalidam a licença.
- Guardada de forma segura no cofre do sistema (atrelada à máquina), sem enfraquecer o vínculo por computador.
- Trocar/desativar a licença re-detecta o hardware no próximo arranque (para troca real de máquina).

### Conexão do chip mais confiável (QR que não aparecia)
Corrige o chip que ficava preso em "Estabelecendo conexão…" e **nunca gerava o QR**.

- **Não depende mais de acesso ao GitHub para conectar** — a busca de versão do WhatsApp Web agora tem tempo limite e não trava mais o pareamento em redes que bloqueiam esse acesso (firewall/antivírus/provedor).
- **Sessão corrompida se recupera sozinha** — em vez de tentar reusar credenciais quebradas para sempre, o chip limpa e volta a pedir um QR novo.
- **Fim do "conectando" infinito e mudo** — após algumas tentativas sem sucesso, o app **para e mostra o motivo** ("verifique internet, firewall ou antivírus") em vez de girar sem fim.
