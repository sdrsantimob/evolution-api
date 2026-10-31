import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';
import { AuthenticationCreds, AuthenticationState, initAuthCreds, proto, SignalDataTypeMap } from 'baileys';

import { CredsCopies, loadCreds, makeSaveCreds } from './credsStore';

export async function useMultiFileAuthStateRedisDb(
  instanceName: string,
  cache: CacheService,
  // Cópia do crachá no banco do conector (modo anterior), usada como cópia de segurança: na 1ª
  // partida o crachá vem de lá por dentro do processo; depois ela é renovada a cada 24h.
  dbCopy?: { read: () => Promise<any | null>; write: (creds: any) => Promise<void> },
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  removeCreds: () => Promise<void>;
}> {
  const logger = new Logger('useMultiFileAuthStateRedisDb');

  const writeData = async (data: any, key: string): Promise<any> => {
    try {
      return await cache.hSet(instanceName, key, data);
    } catch (error) {
      return logger.error({ localError: 'writeData', error });
    }
  };

  const readData = async (key: string): Promise<any> => {
    try {
      return await cache.hGet(instanceName, key);
    } catch (error) {
      logger.error({ localError: 'readData', error });
      return;
    }
  };

  const removeData = async (key: string) => {
    try {
      return await cache.hDelete(instanceName, key);
    } catch (error) {
      logger.error({ readData: 'removeData', error });
    }
  };

  async function removeCreds(): Promise<any> {
    try {
      logger.warn({ action: 'redis.delete', instanceName });

      return await cache.delete(instanceName);
    } catch {
      return;
    }
  }

  // Crachá: principal no Redis, cópia de segurança no banco (ver utils/credsStore). Erro interrompe
  // aqui (a conexão não abre e tenta de novo depois); só "não existe" confirmado vira crachá novo (QR).
  const copies: CredsCopies = {
    readRedis: () => cache.hGetStrict(instanceName, 'creds'),
    writeRedis: (c) => cache.hSet(instanceName, 'creds', c),
    ...(dbCopy ? { readDb: dbCopy.read, writeDb: dbCopy.write } : {}),
  };
  const save = makeSaveCreds(copies, 'redis', logger, instanceName);
  const creds: AuthenticationCreds = (await loadCreds(copies, 'redis', logger, instanceName)) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids: string[]) => {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const data: { [_: string]: SignalDataTypeMap[type] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.create(value);
              }

              data[id] = value;
            }),
          );

          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? await writeData(value, key) : await removeData(key));
            }
          }

          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      return await save(creds);
    },

    removeCreds,
  };
}
