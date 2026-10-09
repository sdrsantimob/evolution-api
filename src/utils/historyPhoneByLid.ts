import { isLidUser, isPnUser, jidNormalizedUser } from 'baileys';

// [WA-34] Par telefone↔identificador (lid) que o WhatsApp manda junto do histórico.
//
// No pareamento, cada conversa do histórico chega com o endereço dela (`id`) e, quando o
// WhatsApp informa, com as duas formas: `lid` (identificador novo) e `phoneNumber` (telefone).
// As mensagens dessa conversa trazem só UMA das formas na chave. Estas funções montam o par e
// anexam o telefone à chave da mensagem, para quem recebe o aviso saber de quem é a conversa.
//
// Regra deste arquivo: nada aqui grava em banco e nada aqui escreve em log — o par só existe
// dentro do pacote que já carrega as mensagens.

export type HistoryContact = { id?: string | null; lid?: string | null; phoneNumber?: string | null };
export type HistoryKey = { remoteJid?: string | null; remoteJidAlt?: string | null };

export function buildPhoneByLid(contacts: HistoryContact[] | undefined | null): Map<string, string | null> {
  const phoneByLid = new Map<string, string | null>();

  for (const contact of contacts ?? []) {
    const lid = isLidUser(contact?.lid ?? undefined)
      ? contact.lid
      : isLidUser(contact?.id ?? undefined)
        ? contact.id
        : null;
    const phone = isPnUser(contact?.phoneNumber ?? undefined)
      ? contact.phoneNumber
      : isPnUser(contact?.id ?? undefined)
        ? contact.id
        : null;

    if (lid && phone) {
      phoneByLid.set(jidNormalizedUser(lid), jidNormalizedUser(phone));
    }
  }

  return phoneByLid;
}

// A conversa da mensagem é endereçada só pelo identificador novo e ainda não tem telefone anexado?
export function needsPhone(key: HistoryKey | undefined | null): boolean {
  return !!key && !!isLidUser(key.remoteJid ?? undefined) && !key.remoteJidAlt;
}

// Anexa o telefone à chave (a forma original do endereço é preservada em `remoteJid`).
export function attachPhone(key: HistoryKey, phone: string | null | undefined): boolean {
  if (!phone || !needsPhone(key)) return false;
  const normalized = jidNormalizedUser(phone);
  if (!isPnUser(normalized)) return false;
  key.remoteJidAlt = normalized;
  return true;
}
