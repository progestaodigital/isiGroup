// Modo privacidade: embaça dados sensíveis na tela.
//
// É uma proteção VISUAL, para gravar vídeo, tirar print ou compartilhar a tela
// sem expor telefone de lead, nome de grupo, seu próprio número e credenciais.
// Não é segurança: o dado continua no app e em memória — quem tem acesso à
// máquina continua tendo acesso a ele.
//
// A marcação é por atributo `data-sensivel` no elemento, e o borrão é ligado
// por uma classe na raiz. Assim o toggle vale para o app inteiro de uma vez,
// sem cada tela precisar saber do estado.

const CHAVE = "isigroup.privacidade";

export type TipoSensivel =
  | "telefone"   // número de lead / contato
  | "nome"       // nome de pessoa
  | "grupo"      // nome de grupo ou comunidade
  | "credencial" // chave, segredo, URL com token, proxy com senha
  | "conteudo";  // texto de mensagem, conhecimento, pergunta feita ao agente

export function lerPreferencia(): boolean {
  try {
    return localStorage.getItem(CHAVE) === "1";
  } catch {
    return false; // navegador bloqueando storage: começa desligado
  }
}

export function salvarPreferencia(ligado: boolean) {
  try {
    localStorage.setItem(CHAVE, ligado ? "1" : "0");
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}

// Aplica/remove a classe na raiz do documento.
export function aplicar(ligado: boolean) {
  document.documentElement.classList.toggle("privacidade", ligado);
}

// Helper para marcar um elemento: <span {...sensivel("telefone")}>{fone}</span>
export const sensivel = (tipo: TipoSensivel) => ({ "data-sensivel": tipo });
