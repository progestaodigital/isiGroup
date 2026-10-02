## isiGroup v0.5.0

### Keymaker: uma mensagem, dezenas de versões (Pro)
A mesma mensagem enviada para 50 grupos sai sempre igual — e isso é o que mais marca
disparo em massa. Agora você escreve as variações no próprio texto, entre chaves e
separadas por barra vertical:

```
{{oi, tudo bem?|olá, como vai?|opa, tudo bem com você?}}
{{Fabio Aleixo aqui|Fabio Aleixo falando|aqui é o Fabio Aleixo}}
```

Cada grupo recebe **uma versão sorteada**, e o app **não repete** enquanto houver
combinação nova. Cada bloco multiplica: 3 variações numa linha e 4 na outra dão
**12 combinações**. Embaixo do campo aparece o total, e **ver exemplos** sorteia
alguns para você conferir antes de salvar.

A mesma sintaxe traz dados do contexto: `{{grupo}}`, `{{chip}}`, `{{saudacao}}`
(bom dia/boa tarde/boa noite), `{{data}}` e `{{hora}}`. Em automações existem também
`{{nome}}` e `{{primeiro_nome}}` de quem entrou ou escreveu — dá para fazer
boas-vindas que não parecem robô.

Funciona em **texto, legenda de imagem/vídeo e enquete**, no agendador e nas
automações. Há dois atalhos no editor: **+ variação** transforma o texto selecionado
num bloco, e o menu **variável…** insere os campos de contexto.

> Isso é variação de **texto**, para a mensagem não ficar repetitiva. Não é truque
> para escapar de detecção: não existe caractere invisível nem letra trocada.
> O pacing entre envios continua sendo só anti-flood, como sempre.

**Mensagem que já existia continua idêntica.** Texto sem chaves não é alterado em nada,
e chaves sem barra vertical saem como você escreveu (`{{R$ 100}}` sai literal).

### Várias mídias por mensagem, em rodízio (Pro)
No passo de imagem, áudio ou vídeo você pode enviar **até 10 arquivos** de uma vez.
Cada grupo recebe um, em rodízio sem repetir. Legenda e arquivo são sorteados de forma
independente: 2 legendas × 4 imagens dão **8 combinações**.

Se um arquivo for apagado do computador, o app usa outro da lista em vez de falhar o
envio — antes, mídia faltando derrubava o disparo.

### Recorrente variável: várias mensagens para o mesmo horário (Pro)
Novo tipo de disparo. Você cadastra, por exemplo, **5 mensagens para segunda às 9:00**;
a cada semana o app escolhe **uma**, e na semana seguinte escolhe uma **diferente** —
todas aparecem antes de qualquer repetição.

Cada opção é uma sequência completa: pode ter vários passos, formatos diferentes,
mídias e variações de texto. As **abas de opção** ficam acima das mensagens, e o botão
**duplicar** cria uma cópia para você só ajustar o que muda. Grupos e chips valem para
o agendamento todo, não por opção.

Dá para escolher entre **sortear sem repetir** (padrão) ou seguir **em ordem**
(1, 2, 3…), se você preferir planejar a sequência.

Se o app cair no meio de um disparo, ao voltar ele continua com a **mesma** opção:
ninguém recebe mensagem pela metade nem duas versões diferentes do mesmo aviso.

### Correção: arquivos órfãos ao editar uma sequência
Editar um agendamento com imagem/áudio/vídeo deixava o arquivo antigo para trás no
disco, ocupando espaço para sempre. Agora a edição limpa o que não é mais usado.

---

Keymaker, rodízio de mídia e recorrente variável são do plano **Pro**. No plano
gratuito o app envia sempre a primeira variação — a mensagem nunca sai com as chaves
à mostra.
