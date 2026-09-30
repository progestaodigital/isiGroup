## isiGroup v0.4.0

### Exportar toda a sua configuração — e restaurar em outro computador
Nova aba **Exportar**. Gera um arquivo com tudo que você configurou, e você escolhe o que entra.

- Marque as seções que quiser: **agendamentos**, **automações e gatilhos**, **agentes de IA**, **edições de grupo recorrentes**, **seleções de grupos salvas** e **configuração dos chips**.
- O arquivo preserva **tudo**: dia da semana, horário, semana par ou ímpar, o texto de cada mensagem da sequência, o intervalo entre elas, enquetes, imagens e áudios, o conhecimento dos agentes, a triagem e os grupos onde cada coisa vale.
- Para restaurar, importe em **Planos & IA → Importar plano** — no mesmo computador ou em outro. O arquivo exportado é um plano comum, então você vê a prévia completa e confirma antes de qualquer coisa ser criada.
- Os grupos são encontrados **pelo nome**. Isso permite levar sua configuração para outra máquina com outros grupos, desde que os nomes sejam os mesmos. Se você tiver dois grupos com o mesmo nome, o app avisa na hora de exportar.
- **Segredos dos webhooks**: você decide. Deixe desmarcado para compartilhar o arquivo com segurança; marque para fazer backup seu, com tudo pronto para voltar a funcionar.
- Sai só configuração — histórico de disparos, logs e perguntas feitas aos agentes não entram. E nunca saem: a sessão do WhatsApp, a chave da licença e a chave da OpenAI.

### Modo privacidade: embaça dados sensíveis na tela
Novo interruptor na **Visão geral**, para gravar vídeo, tirar print ou compartilhar a tela sem expor dados de ninguém.

- Embaça telefones e nomes de leads, nomes de grupos, **o seu próprio número**, credenciais e a URL do proxy.
- Passe o mouse sobre qualquer campo para revelá-lo, sem precisar desligar o modo.
- A escolha fica guardada entre um uso e outro.
- É proteção **visual**: o dado continua no app normalmente, apenas não aparece na tela.

### Conhecimento dos agentes não se perde mais
Ao cadastrar conhecimento sem ter a chave da OpenAI configurada, o texto era recusado e perdido. Agora ele fica guardado como **"aguarda a chave"** e é processado automaticamente assim que você cadastrar a chave.
