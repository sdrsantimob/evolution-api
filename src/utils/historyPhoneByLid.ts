import { isLidUser, isPnUser, jidNormalizedUser } from 'baileys';

// [WA-34] Par telefone↔identificador (lid) que o WhatsApp manda junto do histórico.
//
// No pareamento, cada conversa do histórico chega com o endereço dela (`id`) e, quando o
// WhatsApp informa, com as duas formas: `lid` (identificador novo) e `phoneNumber` (telefone).
// As mensagens dessa conversa trazem só UMA das formas na chave. Este arquivo monta o par e
// anexa o telefone à chave da mensagem, para quem recebe o aviso saber de quem é a conversa.
//
// O par de uma conversa sem nome na agenda só vem no PRIMEIRO pacote em que ela aparece (a
// biblioteca descarta o contato repetido nos pacotes seguintes). Por isso o par é lembrado
// enquanto a conexão está de pé — só na memória do processo, com teto, e esquecido quando a
// conexão é encerrada.
//
// Regra deste arquivo: nada aqui grava em banco, arquivo ou armazenamento externo e nada aqui
// escreve em registro. O par só existe na memória e dentro do pacote que já carrega as mensagens.

export type HistoryContact = { id?: unknown; lid?: unknown; phoneNumber?: unknown };
export type HistoryKey = { remoteJid?: string | null; remoteJidAlt?: string | null };
export type PhoneLookup = (lid: string) => Promise<string | null | undefined> | string | null | undefined;

const MAX_PAIRS = 50_000;

const asLid = (value: unknown): string | null => (typeof value === 'string' && isLidUser(value) ? value : null);
const asPhone = (value: unknown): string | null => (typeof value === 'string' && isPnUser(value) ? value : null);

export function buildPhoneByLid(contacts: HistoryContact[] | undefined | null): Map<string, string> {
  const phoneByLid = new Map<string, string>();

  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const lid = asLid(contact?.lid) ?? asLid(contact?.id);
    const phone = asPhone(contact?.phoneNumber) ?? asPhone(contact?.id);

    if (lid && phone) {
      phoneByLid.set(jidNormalizedUser(lid), jidNormalizedUser(phone));
    }
  }

  return phoneByLid;
}

// A conversa da mensagem é endereçada só pelo identificador novo e ainda não tem telefone anexado?
export function needsPhone(key: HistoryKey | undefined | null): boolean {
  return !!key && !!asLid(key.remoteJid) && !key.remoteJidAlt;
}

// Anexa o telefone à chave (a forma original do endereço é preservada em `remoteJid`).
export function attachPhone(key: HistoryKey, phone: string | null | undefined): boolean {
  if (typeof phone !== 'string' || !needsPhone(key)) return false;
  const normalized = jidNormalizedUser(phone);
  if (!asPhone(normalized)) return false;
  key.remoteJidAlt = normalized;
  return true;
}

// Mensagem AO VIVO de conversa endereçada pelo identificador novo: quem recebe o aviso precisa
// dos DOIS endereços para saber que é a mesma conversa que o histórico trouxe só pelo
// identificador. Devolve uma cópia com o telefone em `remoteJid` (como o aviso já mandava) e o
// identificador em `remoteJidAlt`. Sem identificador, devolve a própria mensagem, intocada.
export function withBothAddresses<T extends { key?: HistoryKey | null }>(
  message: T,
  lid: string | null | undefined,
): T {
  if (!message?.key || !asLid(lid) || !asPhone(message.key.remoteJid)) return message;
  return { ...message, key: { ...message.key, remoteJidAlt: jidNormalizedUser(lid) } };
}

// O identificador de uma mensagem ao vivo que vai ter o endereço trocado pelo telefone.
export function lidBeforeSwap(key: HistoryKey | undefined | null): string | null {
  if (!key) return null;
  return asLid(key.remoteJid) && asPhone(key.remoteJidAlt) ? (key.remoteJid as string) : null;
}

// Contagens do que o WhatsApp entregou num pacote de histórico e do que foi possível anexar.
// SÓ números: nenhum endereço, nome ou texto entra aqui.
export type HistoryStats = Record<
  | 'chats'
  | 'chatsLid'
  | 'chatsPhone'
  | 'contacts'
  | 'contactsWithPair'
  | 'pairsRemembered'
  | 'messages'
  | 'messagesLid'
  | 'messagesWithPhone'
  | 'attachedFromPacket'
  | 'attachedFromMap'
  | 'unresolved'
  | 'mapHit'
  | 'mapMiss'
  | 'mapError'
  | 'packetsBootstrap'
  | 'packetsRecent'
  | 'packetsFull'
  | 'packetsPushName'
  | 'packetsOther',
  number
>;

// syncType do WhatsApp: 0 = carga inicial · 2 = histórico completo · 3 = recente · 4 = nomes.
export function newHistoryStats(syncType?: number | null): HistoryStats {
  return {
    chats: 0,
    chatsLid: 0,
    chatsPhone: 0,
    contacts: 0,
    contactsWithPair: 0,
    pairsRemembered: 0,
    messages: 0,
    messagesLid: 0,
    messagesWithPhone: 0,
    attachedFromPacket: 0,
    attachedFromMap: 0,
    unresolved: 0,
    mapHit: 0,
    mapMiss: 0,
    mapError: 0,
    packetsBootstrap: syncType === 0 ? 1 : 0,
    packetsRecent: syncType === 3 ? 1 : 0,
    packetsFull: syncType === 2 ? 1 : 0,
    packetsPushName: syncType === 4 ? 1 : 0,
    packetsOther: [0, 2, 3, 4].includes(syncType as number) ? 0 : 1,
  };
}

export function countChatAddresses(stats: HistoryStats, chats: Array<{ id?: unknown }> | undefined | null): void {
  for (const chat of Array.isArray(chats) ? chats : []) {
    stats.chats += 1;
    if (asLid(chat?.id)) stats.chatsLid += 1;
    else if (asPhone(chat?.id)) stats.chatsPhone += 1;
  }
}

// Os pares de UMA conexão, lembrados entre os pacotes do histórico. Só memória.
export class HistoryPhoneBook {
  private readonly known = new Map<string, string>();

  get size(): number {
    return this.known.size;
  }

  has(lid: string | null | undefined): boolean {
    return !!asLid(lid) && this.known.has(jidNormalizedUser(lid));
  }

  // Junta os pares que vieram neste pacote. Devolve quantos pares o pacote trouxe.
  remember(contacts: HistoryContact[] | undefined | null): number {
    const pairs = buildPhoneByLid(contacts);
    if (this.known.size + pairs.size > MAX_PAIRS) {
      this.known.clear();
    }
    for (const [lid, phone] of pairs) {
      this.known.set(lid, phone);
    }
    return pairs.size;
  }

  // Telefone da conversa: o par lembrado; sem ele, `lookup` (o mapa que a biblioteca mantém na
  // sessão). `misses` evita perguntar duas vezes pelo mesmo endereço dentro do mesmo pacote.
  // Nunca lança: sem telefone, a mensagem segue como antes.
  async phoneFor(lid: string | null | undefined, lookup?: PhoneLookup, misses?: Set<string>): Promise<string | null> {
    if (!asLid(lid)) return null;
    const key = jidNormalizedUser(lid);

    const known = this.known.get(key);
    if (known) return known;
    if (!lookup || misses?.has(key)) return null;

    let phone: string | null = null;
    try {
      const found = await lookup(key);
      const normalized = typeof found === 'string' ? jidNormalizedUser(found) : null;
      phone = asPhone(normalized);
    } catch {
      phone = null;
    }

    if (phone) {
      this.known.set(key, phone);
    } else {
      misses?.add(key);
    }
    return phone;
  }

  clear(): void {
    this.known.clear();
  }
}
