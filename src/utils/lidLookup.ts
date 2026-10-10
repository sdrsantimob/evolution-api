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
//   • intervalo mínimo entre consultas da mesma conexão, contado do FIM da anterior e também
//     quando ela falha;
//   • a consulta desiste sozinha depois de LID_LOOKUP_TIMEOUT_MS;
//   • a consulta NÃO roda quando a biblioteca do WhatsApp está com o registro detalhado ligado
//     (níveis em que ela imprime a pergunta e a resposta inteiras) — ver `logLevelIsQuiet`.
//
// Regra deste arquivo: nada aqui grava em banco, cache, arquivo ou armazenamento da sessão, e
// nada aqui escreve em registro. O número e o identificador só existem dentro da chamada; o que
// fica na memória entre uma consulta e outra é a hora da última e se há uma em andamento.
//
// O que este arquivo NÃO controla (e o que controla): a memória é da conexão — reiniciar o
// serviço ou recriar a conexão zera o intervalo; o corpo da requisição não sai pelo monitor de
// erros porque `sentryScrub.ts` o apaga de todo evento.

export const LID_LOOKUP_MIN_INTERVAL_MS = 30_000;
export const LID_LOOKUP_TIMEOUT_MS = 20_000;

export type LidLookupOutcome =
  | 'found'
  | 'not_found'
  | 'invalid'
  | 'offline'
  | 'unsafe'
  | 'busy'
  | 'interval'
  | 'failed';
export type LidLookupResult = { outcome: LidLookupOutcome; lid?: string };
export type USyncAnswer = { list?: Array<{ id?: unknown; lid?: unknown }> } | undefined | null;
export type USyncExecutor = (query: USyncQuery) => Promise<USyncAnswer>;

const PHONE_DOMAIN = '@s.whatsapp.net';

// Níveis de registro da biblioteca do WhatsApp em que ela não imprime o tráfego. Em `trace` ela
// imprime cada pergunta e cada resposta inteiras; em `debug`, a resposta que chega atrasada.
// Lista fechada do que é seguro: nível desconhecido ou ausente NÃO é seguro.
const QUIET_LOG_LEVELS = new Set(['error', 'fatal', 'silent']);

export function logLevelIsQuiet(level: unknown): boolean {
  return typeof level === 'string' && QUIET_LOG_LEVELS.has(level);
}

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
    private readonly timeoutMs: number = LID_LOOKUP_TIMEOUT_MS,
  ) {}

  // Nunca lança: o motivo de uma falha não sai daqui (a mensagem de erro poderia levar o número).
  // `logLevel` é o nível de registro da biblioteca do WhatsApp nesta conexão.
  async run(number: unknown, exec: USyncExecutor | null | undefined, logLevel?: unknown): Promise<LidLookupResult> {
    const digits = onlyDigits(number);
    if (!digits) return { outcome: 'invalid' };
    if (!logLevelIsQuiet(logLevel)) return { outcome: 'unsafe' };
    if (typeof exec !== 'function') return { outcome: 'offline' };
    if (this.running) return { outcome: 'busy' };
    if (this.lastAt !== null && this.now() - this.lastAt < this.minIntervalMs) return { outcome: 'interval' };

    this.running = true;
    this.lastAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const asked = `${digits}${PHONE_DOMAIN}`;
      const query = new USyncQuery()
        .withLIDProtocol()
        .withContext('background')
        .withUser(new USyncUser().withId(asked));
      // Conexão que cai no meio deixa a pergunta sem resposta: a porta não fica presa nela.
      const gaveUp = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
        timer.unref?.();
      });
      const pending = exec(query);
      pending.catch(() => undefined); // resposta que falha depois da desistência não vira erro solto
      const answer = await Promise.race([pending, gaveUp]);
      if (answer === 'timeout' || !answer) return { outcome: 'failed' };
      const lid = lidOf(answer, asked);
      return lid ? { outcome: 'found', lid } : { outcome: 'not_found' };
    } catch {
      return { outcome: 'failed' };
    } finally {
      if (timer) clearTimeout(timer);
      this.lastAt = this.now(); // o intervalo conta do fim desta consulta
      this.running = false;
    }
  }
}
