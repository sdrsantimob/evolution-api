// O crachá da sessão do WhatsApp (credenciais do aparelho) e as duas cópias dele.
//
// Há duas cópias possíveis: no Redis (campo `creds` da gaveta do número) e no banco do conector
// (tabela Session). Qual vale NÃO depende de onde a cópia está nem do modo em uso: vale a cópia
// pareada mais nova pelo conteúdo. Assim, ir e voltar entre os modos — inclusive voltar a uma
// versão antiga do conector — nunca faz uma cópia velha ou sem pareamento valer sobre a boa.
//
// Regras:
// 1. Erro ao ler a cópia principal do modo interrompe a abertura (tenta de novo depois). Erro nunca
//    vira "não existe", porque "não existe" leva a um crachá novo (QR).
// 2. Cópia pareada sempre vence cópia sem pareamento.
// 3. Mesma conta nas duas: vence a de contadores maiores (pré-chaves enviadas, sincronizações).
//    Contadores em conflito ou contas diferentes: vence a cópia principal do modo, com aviso.
// 4. A cópia que ficou para trás é atualizada na abertura. A cópia de segurança (a que não é a
//    principal) é renovada no máximo a cada 24 horas no modo Redis, e a cada gravação no modo banco.
// 5. Crachá sem pareamento nunca grava por cima de crachá pareado, em nenhuma das cópias.
// 6. As cópias só são apagadas pelo encerramento do número (logout ou exclusão), como antes.
//
// Regra deste arquivo: decide e grava pelo caminho de cada cópia; nunca imprime o crachá.

import { BufferJSON } from 'baileys';

export type Mode = 'redis' | 'db';

export interface CredsCopies {
  /** Leitura do Redis. null = não existe. Erro sobe. Ausente quando o Redis está desligado. */
  readRedis?: () => Promise<any | null>;
  writeRedis?: (creds: any) => Promise<void>;
  /** Leitura do banco. null = não existe. Erro sobe. Ausente quando o banco não guarda o número. */
  readDb?: () => Promise<any | null>;
  writeDb?: (creds: any) => Promise<void>;
}

type Log = { info: (o: any) => void; warn: (o: any) => void };

export const BACKUP_REFRESH_MS = 24 * 60 * 60 * 1000;

const paired = (c: any) => !!c?.me?.id;
const userOf = (c: any) =>
  String(c?.me?.id ?? '')
    .split(':')[0]
    .split('@')[0];
const pub = (c: any) => {
  const k = c?.signedIdentityKey?.public;
  return k ? Buffer.from(k).toString('base64') : '';
};

export function sameAccount(a: any, b: any): boolean {
  return paired(a) && paired(b) && userOf(a) === userOf(b) && pub(a) !== '' && pub(a) === pub(b);
}

const counters = (c: any): number[] => [
  Number(c?.nextPreKeyId ?? 0),
  Number(c?.firstUnuploadedPreKeyId ?? 0),
  Number(c?.accountSyncCounter ?? 0),
  Number(c?.signedPreKey?.keyId ?? 0),
];

/** 1 = a mais nova, -1 = b mais nova, 0 = iguais ou em conflito. */
export function compareFreshness(a: any, b: any): number {
  const ca = counters(a);
  const cb = counters(b);
  const greater = ca.some((v, i) => v > cb[i]);
  const smaller = ca.some((v, i) => v < cb[i]);
  if (greater && !smaller) return 1;
  if (smaller && !greater) return -1;
  return 0;
}

export function sameContent(a: any, b: any): boolean {
  return JSON.stringify(a, BufferJSON.replacer) === JSON.stringify(b, BufferJSON.replacer);
}

/** Qual cópia vale. `primary` é a cópia principal do modo em uso. */
export function chooseCreds(
  redis: any,
  db: any,
  mode: Mode,
): { creds: any; from: 'redis' | 'db' | null; reason: string } {
  const primaryIsRedis = mode === 'redis';
  if (!redis && !db) return { creds: null, from: null, reason: 'nenhuma cópia' };
  if (redis && !db) return { creds: redis, from: 'redis', reason: 'só no Redis' };
  if (db && !redis) return { creds: db, from: 'db', reason: 'só no banco' };
  if (paired(redis) !== paired(db)) {
    return paired(redis)
      ? { creds: redis, from: 'redis', reason: 'só a do Redis está pareada' }
      : { creds: db, from: 'db', reason: 'só a do banco está pareada' };
  }
  if (!sameAccount(redis, db)) {
    return primaryIsRedis
      ? { creds: redis, from: 'redis', reason: 'contas diferentes: vale a principal' }
      : { creds: db, from: 'db', reason: 'contas diferentes: vale a principal' };
  }
  const cmp = compareFreshness(redis, db);
  if (cmp > 0) return { creds: redis, from: 'redis', reason: 'a do Redis é mais nova' };
  if (cmp < 0) return { creds: db, from: 'db', reason: 'a do banco é mais nova' };
  return primaryIsRedis
    ? { creds: redis, from: 'redis', reason: 'iguais: vale a principal' }
    : { creds: db, from: 'db', reason: 'iguais: vale a principal' };
}

/** Abre o crachá: lê as cópias, escolhe a que vale e atualiza a que ficou para trás. */
export async function loadCreds(copies: CredsCopies, mode: Mode, log: Log, id: string): Promise<any | null> {
  const primaryRead = mode === 'redis' ? copies.readRedis : copies.readDb;
  const backupRead = mode === 'redis' ? copies.readDb : copies.readRedis;
  if (!primaryRead) throw new Error('cópia principal do crachá indisponível');

  const primary = await primaryRead(); // regra 1: erro sobe
  let backup: any = null;
  let backupOk = false;
  if (backupRead) {
    try {
      backup = await backupRead();
      backupOk = true;
    } catch {
      // A cópia de segurança fora do ar só impede a abertura quando a principal não tem crachá
      // pareado: senão um crachá novo (QR) poderia nascer com a boa guardada lá.
      if (!paired(primary)) throw new Error('cópia de segurança do crachá indisponível e principal sem pareamento');
      log.warn({ action: 'creds.copia-seguranca.indisponivel', id });
    }
  }

  const redis = mode === 'redis' ? primary : backup;
  const db = mode === 'redis' ? backup : primary;
  const choice = chooseCreds(redis, db, mode);
  if (!choice.creds) return null;
  if (choice.from !== mode) log.info({ action: 'creds.escolhida', de: choice.from, motivo: choice.reason, id });

  // Regra 4: a cópia que ficou para trás recebe a que vale.
  const sync = async (which: 'redis' | 'db', current: any, ok: boolean) => {
    const write = which === 'redis' ? copies.writeRedis : copies.writeDb;
    const read = which === 'redis' ? copies.readRedis : copies.readDb;
    if (!write || !read || !ok) return;
    if (current && sameContent(current, choice.creds)) return;
    if (paired(current) && !paired(choice.creds)) return; // regra 5
    await write(choice.creds);
    const check = await read();
    if (!check || !sameContent(check, choice.creds)) throw new Error(`cópia do crachá (${which}) não confirmada`);
    log.info({ action: 'creds.copia-atualizada', para: which, id });
  };

  const primaryWhich: 'redis' | 'db' = mode;
  const backupWhich: 'redis' | 'db' = mode === 'redis' ? 'db' : 'redis';
  await sync(primaryWhich, primary, true); // a principal precisa ficar certa: erro sobe
  try {
    await sync(backupWhich, backup, backupOk);
  } catch {
    log.warn({ action: 'creds.copia-seguranca.nao-atualizada', id });
  }
  return choice.creds;
}

/** Grava o crachá na principal e renova a cópia de segurança (regras 4 e 5). */
export function makeSaveCreds(copies: CredsCopies, mode: Mode, log: Log, id: string, now: () => number = Date.now) {
  let lastBackupAt = now();
  return async (creds: any) => {
    const primaryRead = mode === 'redis' ? copies.readRedis : copies.readDb;
    const primaryWrite = mode === 'redis' ? copies.writeRedis : copies.writeDb;
    const backupRead = mode === 'redis' ? copies.readDb : copies.readRedis;
    const backupWrite = mode === 'redis' ? copies.writeDb : copies.writeRedis;

    if (!paired(creds)) {
      let stored: any;
      try {
        stored = await primaryRead();
      } catch {
        log.warn({ action: 'creds.save.adiado', motivo: 'cópia principal indisponível', id });
        return;
      }
      if (paired(stored)) {
        log.warn({ action: 'creds.save.recusado', motivo: 'crachá sem pareamento sobre crachá pareado', id });
        return;
      }
    }
    await primaryWrite(creds);

    if (!backupWrite) return;
    const due = mode === 'db' || now() - lastBackupAt >= BACKUP_REFRESH_MS;
    if (!due) return;
    try {
      if (!paired(creds) && paired(await backupRead())) return;
      await backupWrite(creds);
      lastBackupAt = now();
    } catch {
      log.warn({ action: 'creds.copia-seguranca.nao-atualizada', id });
    }
  };
}
