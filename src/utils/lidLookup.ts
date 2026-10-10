import { isLidUser, jidNormalizedUser, USyncQuery, USyncUser } from 'baileys';

// [WA-37] Consulta "número → identificador (lid)" ao WhatsApp, UM número por vez.
//
// O histórico do pareamento não traz o par telefone/identificador (medido em 09 e 10/10/2026).
// Para uma conversa que quem usa marcou como pessoal, o sistema pergunta ao WhatsApp qual é o
// identificador daquele número — e só assim sabe reconhecer a mesma conversa quando ela chega
// pelo identificador.
//
// A biblioteca tem um caminho pronto para isso (`lidMapping.getLIDsForPNs`), mas ele GRAVA o par
// no armazenamento da sessão. Este arquivo NÃO usa esse caminho: monta a pergunta e a entrega a
// quem chamou (`exec`, que é o `executeUSyncQuery` da conexão), que só pergunta e devolve.
//
// Limites por construção (não são configuração: não há variável que os afrouxe):
//   • um número por consulta — lista, endereço pronto ou qualquer coisa que não seja só dígitos
//     é recusada antes de falar com o WhatsApp;
//   • uma consulta por vez por conexão;
//   • intervalo mínimo entre consultas da mesma conexão, contado inclusive quando a consulta falha.
//
// Regra deste arquivo: nada aqui grava em banco, cache, arquivo ou armazenamento da sessão, e
// nada aqui escreve em registro. O número e o identificador só existem dentro da chamada; o que
// fica na memória entre uma consulta e outra é a hora da última e se há uma em andamento.

export const LID_LOOKUP_MIN_INTERVAL_MS = 30_000;

export type LidLookupOutcome = 'found' | 'not_found' | 'invalid' | 'offline' | 'busy' | 'interval' | 'failed';
export type LidLookupResult = { outcome: LidLookupOutcome; lid?: string };
export type USyncAnswer = { list?: Array<{ id?: unknown; lid?: unknown }> } | undefined | null;
export type USyncExecutor = (query: USyncQuery) => Promise<USyncAnswer>;

const PHONE_DOMAIN = '@s.whatsapp.net';

const onlyDigits = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{10,15}$/.test(value) ? value : null;

// O identificador que o WhatsApp devolveu PARA O NÚMERO PERGUNTADO. Resposta sobre outro número,
// sem identificador ou com algo que não é um identificador não vale: sem par, nada é devolvido.
function lidOf(answer: USyncAnswer, asked: string): string | null {
  for (const entry of Array.isArray(answer?.list) ? answer.list : []) {
    if (typeof entry?.id !== 'string' || jidNormalizedUser(entry.id) !== asked) continue;
    if (typeof entry.lid !== 'string') continue;
    const lid = jidNormalizedUser(entry.lid);
    if (isLidUser(lid)) return lid;
  }
  return null;
}

// A porta de UMA conexão. Só memória.
export class LidLookupGate {
  private running = false;
  private lastAt: number | null = null;

  constructor(
    private readonly minIntervalMs: number = LID_LOOKUP_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  // Nunca lança: o motivo de uma falha não sai daqui (a mensagem de erro poderia levar o número).
  async run(number: unknown, exec: USyncExecutor | null | undefined): Promise<LidLookupResult> {
    const digits = onlyDigits(number);
    if (!digits) return { outcome: 'invalid' };
    if (typeof exec !== 'function') return { outcome: 'offline' };
    if (this.running) return { outcome: 'busy' };

    const at = this.now();
    if (this.lastAt !== null && at - this.lastAt < this.minIntervalMs) return { outcome: 'interval' };

    this.running = true;
    this.lastAt = at;
    try {
      const asked = `${digits}${PHONE_DOMAIN}`;
      const query = new USyncQuery()
        .withLIDProtocol()
        .withContext('background')
        .withUser(new USyncUser().withId(asked));
      const answer = await exec(query);
      if (!answer) return { outcome: 'failed' };
      const lid = lidOf(answer, asked);
      return lid ? { outcome: 'found', lid } : { outcome: 'not_found' };
    } catch {
      return { outcome: 'failed' };
    } finally {
      this.running = false;
    }
  }
}
