## isiGroup v0.3.0

### Correção: webhooks agora enviam a chave nos cabeçalhos padrão
Integrações com isiFlow, n8n, Make, Zapier e endpoints próprios estavam **falhando com "chave inválida" mesmo com a chave certa configurada dos dois lados**.

- O app só enviava uma *assinatura* derivada da chave, num cabeçalho próprio que nenhuma ferramenta do mercado conhece — a chave em si nunca chegava ao destino.
- Agora toda entrega leva a chave, exatamente como você a cadastrou, em **`x-api-key`** e em **`Authorization: Bearer`**, que é onde essas ferramentas procuram.
- A assinatura continua sendo enviada, para quem já validava por ela — nada quebra de quem estava funcionando.
- Vale para **todos** os gatilhos (entrou, saiu, mensagem, link), e a chave vai junto também nas tentativas de reenvio.

### Correção: o app não desiste mais de reconectar
Se o computador hibernava, suspendia, trocava de Wi-Fi ou a internet caía por mais de um minuto, **o chip ficava desconectado para sempre** — e sem chip conectado, nenhuma automação disparava até alguém perceber e reconectar na mão.

- O app tentava reconectar por 60 segundos e então parava de vez. Ao voltar da hibernação, o Windows costuma levar mais que isso para restaurar a rede — então ele desistia pouco antes de a internet voltar.
- Agora, depois das tentativas rápidas, ele passa a **tentar de minuto em minuto, sem desistir**. Assim que a rede volta, o chip religa sozinho.
- A tela de Conexão mostra a diferença: **amarelo** quando é queda passageira e o app está se resolvendo sozinho, **vermelho** quando parou e depende de você (por exemplo, aparelho desvinculado, que exige QR novo).

### Novo: Agentes de IA com base de conhecimento
Nova aba **Agentes de IA** (Pro). Agentes respondem perguntas dentro do grupo usando **apenas** o conteúdo que você cadastrar — não inventam.

- Você usa a **sua** chave da OpenAI; o consumo é cobrado direto na sua conta. A chave fica no cofre do Windows, nunca em arquivo nem no banco do app.
- Cadastre o conhecimento colando texto, enviando **.txt, .md, .pdf ou .docx**, ou apontando uma página da web.
- **Triagem**: quando há vários agentes, ela lê a pergunta e escolhe o mais indicado. Se ele não souber, tenta o próximo — você decide quantas tentativas.
- Escolha **quando** o agente responde: ao mencionarem o chip, por uma palavra-chave que você define, ou em toda mensagem.
- Se nenhum agente souber, o app **fica calado** em vez de arriscar uma resposta errada — e registra a pergunta para você melhorar a base.
- Um painel de testes mostra o que o agente encontraria antes de você soltá-lo num grupo, e há limite automático de respostas por hora para a conta não disparar.

Nada disso liga sozinho: exige chave, agente, conhecimento e vínculo com o grupo — quatro passos deliberados.
