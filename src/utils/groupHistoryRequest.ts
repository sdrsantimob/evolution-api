// [WA-70] Pedido de histórico antigo de UM GRUPO ao celular, por esta conexão.
//
// O histórico do pareamento chega uma vez só, quando o celular conecta. Para um grupo que o dono
// liberou DEPOIS disso, o único jeito de trazer o que veio antes é pedir ao celular, grupo a
// grupo, "as N mensagens anteriores a esta". O celular responde pelo mesmo aviso de histórico de
// sempre (`messaging-history.set`, tipo ON_DEMAND → aviso `messages.set` para o sistema), que já
// tem destino lacrado no sistema. Esta porta SÓ faz o pedido: o que volta não passa por aqui.
//
// Limites por construção (não são configuração: não há variável que os afrouxe):
//   • só endereço de GRUPO (`…@g.us`). Conversa de pessoa, lista de transmissão, canal ou status
//     são recusados antes de falar com o WhatsApp — esta porta nunca puxa conversa individual;
//   • o pedido leva exatamente os campos da mensagem âncora (id, de quem, quando) e nada mais;
//   • no máximo GROUP_HISTORY_MAX_COUNT mensagens por pedido;
//   • um pedido por vez por conexão e intervalo mínimo entre pedidos, contado também na falha;
//   • não roda com o registro detalhado da biblioteca do WhatsApp ligado (ela imprimiria o aviso
//     de histórico com o endereço do pacote) — ver `logLevelIsQuiet` em lidLookup.ts.
//
// Regra deste arquivo: nada aqui grava em banco, cache, arquivo ou sessão, e nada aqui escreve em
// registro. A resposta diz só o desfecho — nunca o endereço do grupo nem o id da mensagem.

import { logLevelIsQuiet } from './lidLookup';

export const GROUP_HISTORY_MAX_COUNT = 50;
export const GROUP_HISTORY_MIN_INTERVAL_MS = 5_000;
export const GROUP_HISTORY_TIMEOUT_MS = 20_000;

export type GroupHistoryOutcome = 'requested' | 'invalid' | 'offline' | 'unsafe' | 'busy' | 'interval' | 'failed';
export type GroupHistoryResult = { outcome: GroupHistoryOutcome };

export type GroupHistoryAnchor = {
  key: { remoteJid: string; id: string; fromMe: boolean; participant?: string };
  timestampMs: number;
  count: number;
};
export type GroupHistoryExecutor = (
  count: number,
  key: GroupHistoryAnchor['key'],
  timestampMs: number,
) => Promise<unknown>;

const GROUP_JID = /^[0-9-]{6,64}@g\.us$/;
const MESSAGE_ID = /^[A-Za-z0-9]{8,64}$/;
const PARTICIPANT = /^[0-9]{5,20}(:[0-9]{1,3})?@(s\.whatsapp\.net|lid)$/;
const ALLOWED_KEYS = new Set(['remoteJid', 'id', 'fromMe', 'participant', 'timestampMs', 'count']);
// Âncora no futuro é engano (relógio errado ou campo trocado): recusa.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
// WhatsApp não existe antes de 2009: âncora antes disso é campo em segundos ou lixo.
const OLDEST_MS = Date.UTC(2009, 0, 1);

// Lê o corpo do pedido. Qualquer campo a mais, faltando ou fora do formato → null.
export function parseGroupHistoryBody(body: unknown, now: number = Date.now()): GroupHistoryAnchor | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.some((k) => !ALLOWED_KEYS.has(k))) return null;
  if (typeof b.remoteJid !== 'string' || !GROUP_JID.test(b.remoteJid)) return null;
  if (typeof b.id !== 'string' || !MESSAGE_ID.test(b.id)) return null;
  if (typeof b.fromMe !== 'boolean') return null;
  if (b.participant !== undefined && (typeof b.participant !== 'string' || !PARTICIPANT.test(b.participant))) {
    return null;
  }
  const ts = b.timestampMs;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < OLDEST_MS || ts > now + FUTURE_SLACK_MS) return null;
  let count = GROUP_HISTORY_MAX_COUNT;
  if (b.count !== undefined) {
    if (typeof b.count !== 'number' || !Number.isInteger(b.count) || b.count < 1) return null;
    count = Math.min(b.count, GROUP_HISTORY_MAX_COUNT);
  }
  const key: GroupHistoryAnchor['key'] = { remoteJid: b.remoteJid, id: b.id, fromMe: b.fromMe };
  if (typeof b.participant === 'string') key.participant = b.participant;
  return { key, timestampMs: ts, count };
}

// A porta de UMA conexão. Só memória (se há pedido em andamento e a hora do último).
export class GroupHistoryGate {
  private running = false;
  private lastAt: number | null = null;

  constructor(
    private readonly minIntervalMs: number = GROUP_HISTORY_MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = GROUP_HISTORY_TIMEOUT_MS,
  ) {}

  // Nunca lança: o motivo de uma falha não sai daqui (a mensagem de erro poderia levar o endereço).
  async run(
    body: unknown,
    exec: GroupHistoryExecutor | null | undefined,
    logLevel?: unknown,
  ): Promise<GroupHistoryResult> {
    const anchor = parseGroupHistoryBody(body, this.now());
    if (!anchor) return { outcome: 'invalid' };
    if (!logLevelIsQuiet(logLevel)) return { outcome: 'unsafe' };
    if (typeof exec !== 'function') return { outcome: 'offline' };
    if (this.running) return { outcome: 'busy' };
    if (this.lastAt !== null && this.now() - this.lastAt < this.minIntervalMs) return { outcome: 'interval' };

    this.running = true;
    this.lastAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const gaveUp = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      });
      const pending = Promise.resolve().then(() => exec(anchor.count, anchor.key, anchor.timestampMs));
      pending.catch(() => undefined); // falha depois da desistência não vira erro solto
      const sent = await Promise.race([pending, gaveUp]);
      return sent === 'timeout' ? { outcome: 'failed' } : { outcome: 'requested' };
    } catch {
      return { outcome: 'failed' };
    } finally {
      if (timer) clearTimeout(timer);
      this.lastAt = this.now();
      this.running = false;
    }
  }
}
