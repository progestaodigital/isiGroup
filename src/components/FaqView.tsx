import { useState } from "react";

interface QA {
  q: string;
  a: React.ReactNode;
}

function buildFaq(isPro: boolean): { group: string; items: QA[] }[] {
  return [
  {
    group: "Banimento e segurança da conta",
    items: [
      {
        q: "Tem risco de banimento?",
        a: (
          <>
            Sim. A isigroup conecta via <b>Aparelhos Conectados</b> usando uma biblioteca não-oficial
            (Baileys), o que <b>viola os Termos de Serviço do WhatsApp</b>. O número usado corre risco de
            banimento, sem padrão previsível. Por isso a recomendação forte: use um{" "}
            <b>número secundário dedicado</b>, nunca o seu principal.
          </>
        ),
      },
      {
        q: "Como reduzir o risco de banimento?",
        a: (
          <ul>
            <li>Use um <b>número secundário</b> só para essa operação.</li>
            <li>Não <b>floode</b>: mantenha espaçamento entre envios (o app já faz isso).</li>
            <li>Evite <b>marcar todos (@all)</b> sem necessidade — é um dos padrões mais sinalizados.</li>
            <li>Evite mandar a <b>mesma mensagem</b> para muitos grupos em poucos segundos.</li>
            <li>Aja sobre os <b>seus próprios grupos</b>, com gente que optou por estar ali.</li>
            <li>Não force reconexão agressiva (o app reconecta com intervalo crescente de propósito).</li>
            <li>Esquente o número aos poucos; evite volume alto logo após conectar.</li>
          </ul>
        ),
      },
      {
        q: "Por que usar um número secundário?",
        a: (
          <>
            A sessão conectada tem <b>acesso amplo</b> (igual a um WhatsApp Web). Se o número for banido,
            você não perde o principal. O secundário existe só para a operação e é descartável.
          </>
        ),
      },
      {
        q: "Posso usar minha conta principal?",
        a: (
          <>
            <b>Fortemente desaconselhado.</b> O risco de banimento é real e imprevisível. Se acontecer com o
            principal, você perde acesso ao seu número pessoal.
          </>
        ),
      },
      {
        q: "Isso é uma ferramenta de evasão/detecção?",
        a: (
          <>
            Não. A operação é de <b>conta única, sem proxy e sem rotação</b>. O espaçamento entre envios
            (pacing) existe só para <b>não floodar</b> e respeitar limites de taxa — nunca para evadir
            detecção. É uma operação legítima sobre os seus próprios grupos.
          </>
        ),
      },
      {
        q: "O @all (marcar todos) é arriscado?",
        a: (
          <>
            O <b>@all</b> notifica todos os membros de forma oculta (ping silencioso). É útil para avisos,
            mas <b>usar demais aumenta incômodo e risco</b>. Use com parcimônia, em grupos seus.
          </>
        ),
      },
    ],
  },
  {
    group: "Grupos, admin e ações",
    items: [
      {
        q: "Posso agendar/automatizar em grupos onde não sou admin?",
        a: isPro ? (
          <>
            Sim. Você pode selecionar <b>qualquer grupo</b> que a sua conta participa (os de membro
            aparecem marcados como <i>(membro)</i>). Mas em grupos configurados como{" "}
            <b>"só administradores enviam"</b>, mensagens de membro <b>vão falhar</b> (aparece como
            "falhou" no status).
          </>
        ) : (
          <>
            Não. O isiGroup atua <b>apenas nos grupos onde a sua conta é administradora</b> — apenas esses
            aparecem nas listas do agendador e das automações.
          </>
        ),
      },
      {
        q: 'Por que a ação "Excluir do grupo" às vezes não funciona?',
        a: (
          <>
            Excluir alguém exige que sua conta seja <b>admin</b> naquele grupo. Em grupos de membro, a
            remoção falha. Além disso, há uma <b>trava de segurança</b>: a automação <b>nunca remove um
            admin</b>, para evitar autoexpulsão por engano.
          </>
        ),
      },
      {
        q: 'Por que "Mensagem no privado" ou o número (E.164) às vezes não funciona?',
        a: (
          <>
            O WhatsApp passou a identificar membros por <b>LID</b> (um id de privacidade), e nem sempre é
            possível obter o número de telefone real a partir dele. Por isso a <b>DM</b> e o campo{" "}
            <code>phone_e164</code> no webhook podem não funcionar em todos os casos.
          </>
        ),
      },
    ],
  },
  {
    group: "Conexão e funcionamento",
    items: [
      {
        q: "Preciso reconectar toda vez que abro o app?",
        a: (
          <>
            Não. A sessão é salva e o app <b>reconecta sozinho</b> ao abrir. Você só escaneia o QR na
            primeira vez (ou se sair/trocar de conexão).
          </>
        ),
      },
      {
        q: "A conexão cai sozinha?",
        a: (
          <>
            Quedas podem acontecer (é a natureza do protocolo). O app <b>reconecta automaticamente</b> com
            intervalo crescente (backoff), evitando loop agressivo.
          </>
        ),
      },
      {
        q: "Minhas conversas privadas ficam salvas no app?",
        a: (
          <>
            Não. A isigroup <b>não armazena conversas privadas</b>. Ela só observa os eventos e mensagens
            de grupo que você configurar nas automações. A sessão fica no disco e a sua license-key fica no
            cofre do sistema (keyring), nunca em texto puro.
          </>
        ),
      },
      {
        q: "Posso enviar áudio, vídeo, imagem e enquete?",
        a: (
          <>
            Sim. O agendador (e as ações de automação) enviam <b>texto, imagem, áudio (nota de voz),
            vídeo e enquete</b>, inclusive em <b>sequência</b> (várias mensagens com intervalo). O áudio é
            convertido automaticamente para o formato de nota de voz.
          </>
        ),
      },
      {
        q: "O agendamento sobrevive se eu fechar o app?",
        a: (
          <>
            Sim. A fila fica salva em disco. Se o app reiniciar, os agendamentos futuros continuam valendo
            e disparam no horário (desde que o app esteja aberto e conectado na hora).
          </>
        ),
      },
      ...(isPro
        ? [
            {
              q: "Como criar várias versões de uma mensagem (Keymaker)?",
              a: (
                <>
                  Escreva as variações entre chaves, separadas por barra vertical:{" "}
                  <code>{"{{oi, tudo bem?|olá, como vai?|opa!}}"}</code>. Cada grupo recebe uma, sorteada{" "}
                  <b>sem repetir</b> enquanto houver combinação nova. Cada bloco novo multiplica: 3 variações
                  numa linha e 4 em outra dão <b>12 combinações</b>. O contador embaixo do campo mostra o total
                  e o botão <i>ver exemplos</i> sorteia alguns para você conferir.
                  <br />
                  <br />
                  A mesma sintaxe traz dados do contexto: <code>{"{{grupo}}"}</code>,{" "}
                  <code>{"{{chip}}"}</code>, <code>{"{{saudacao}}"}</code> (bom dia/boa tarde/boa noite),{" "}
                  <code>{"{{data}}"}</code> e <code>{"{{hora}}"}</code>. Em automações existem também{" "}
                  <code>{"{{nome}}"}</code> e <code>{"{{primeiro_nome}}"}</code> de quem entrou ou escreveu.
                  <br />
                  <br />
                  Chaves <b>sem</b> barra saem como você escreveu (<code>{"{{R$ 100}}"}</code> sai literal), e
                  texto sem chave nenhuma não é alterado. Isso é variação de <b>texto</b>, para a mensagem não
                  ficar repetitiva — não é truque para escapar de detecção.
                </>
              ),
            },
            {
              q: "Posso colocar várias imagens e o app alternar entre elas?",
              a: (
                <>
                  Sim. No passo de imagem, áudio ou vídeo, envie <b>até 10 arquivos</b> (pode selecionar vários
                  de uma vez). Cada grupo recebe um, em <b>rodízio</b> sem repetir. Legenda e arquivo são
                  sorteados de forma independente, então 2 legendas × 4 imagens dão <b>8 combinações</b>.
                  <br />
                  <br />
                  Se um arquivo for apagado do computador, o app usa outro da lista em vez de falhar o envio.
                </>
              ),
            },
            {
              q: "O que é o recorrente variável?",
              a: (
                <>
                  É um agendamento semanal com <b>várias opções de mensagem</b> para o mesmo dia e horário. A
                  cada disparo o app escolhe uma, e no disparo seguinte escolhe uma <b>diferente</b> — todas
                  aparecem antes de qualquer repetição. Cada opção é uma sequência completa: formatos, mídias e
                  variações de texto.
                  <br />
                  <br />
                  Na tela, as <b>abas de opção</b> ficam acima das mensagens, e o botão <i>duplicar</i> cria uma
                  cópia para você só ajustar o que muda. Os grupos e os chips valem para o agendamento todo, não
                  por opção. Se o app cair no meio de um disparo, ao voltar ele continua com a <b>mesma</b> opção
                  — ninguém recebe mensagem pela metade.
                </>
              ),
            },
            {
              q: "Como funcionam vários chips (multi-chip)?",
              a: (
                <>
                  Você seleciona os <b>grupos</b> primeiro; o app mostra quais <b>chips</b> são membros de cada
                  um (<i>cobre X de Y</i>). No disparo, cada grupo é enviado por <b>um</b> chip que já é membro
                  dele, com <b>rodízio</b> entre os chips para distribuir a carga. Grupos sem nenhum chip
                  selecionado que os cubra são <b>pulados</b> (e avisados). O app <b>nunca</b> faz um chip entrar
                  em grupo — trabalha só com o que cada chip já participa.
                </>
              ),
            },
          ]
        : []),
    ],
  },
  ];
}

export function FaqView({ isPro }: { isPro: boolean }) {
  const [open, setOpen] = useState<string | null>("Tem risco de banimento?");
  const faq = buildFaq(isPro);

  return (
    <div>
      <h1>Perguntas Frequentes</h1>
      <p className="muted">Dúvidas comuns sobre uso, limites e segurança da conta.</p>

      {faq.map((section) => (
        <div key={section.group}>
          <h2 className="section-title">{section.group}</h2>
          <div className="list">
            {section.items.map((item) => {
              const isOpen = open === item.q;
              return (
                <div key={item.q} className="card faq-item">
                  <button className="faq-q" onClick={() => setOpen(isOpen ? null : item.q)}>
                    <span>{item.q}</span>
                    <span className="faq-chevron">{isOpen ? "−" : "+"}</span>
                  </button>
                  {isOpen && <div className="faq-a">{item.a}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
