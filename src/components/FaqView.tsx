import { useState } from "react";

interface QA {
  q: string;
  a: React.ReactNode;
}

const FAQ: { group: string; items: QA[] }[] = [
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
        a: (
          <>
            Sim. Você pode selecionar <b>qualquer grupo</b> que sua conta participa (os de membro aparecem
            marcados como <i>(membro)</i>). Mas em grupos configurados como{" "}
            <b>"só administradores enviam"</b>, mensagens de membro <b>vão falhar</b> (aparece como
            "falhou" no status).
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
    ],
  },
];

export function FaqView() {
  const [open, setOpen] = useState<string | null>("Tem risco de banimento?");

  return (
    <div>
      <h1>Perguntas Frequentes</h1>
      <p className="muted">Dúvidas comuns sobre uso, limites e segurança da conta.</p>

      {FAQ.map((section) => (
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
