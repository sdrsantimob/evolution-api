import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';
import { AuthenticationCreds, AuthenticationState, BufferJSON, initAuthCreds, proto, SignalDataTypeMap } from 'baileys';

export async function useMultiFileAuthStateRedisDb(
  instanceName: string,
  cache: CacheService,
  // Leitura do crachá no modo anterior (banco do conector). Usada uma vez, quando o Redis ainda não
  // tem o crachá: copia por dentro do processo, sem o segredo passar por mãos ou arquivos.
  readLegacyCreds?: () => Promise<AuthenticationCreds | null>,
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

  // Erro do Redis ou do banco interrompe aqui (a conexão não abre e tenta de novo depois). Só um
  // "não existe" confirmado nos dois lugares leva a um crachá novo (QR).
  let creds: AuthenticationCreds = await cache.hGetStrict(instanceName, 'creds');
  if (!creds && readLegacyCreds) {
    const legacy = await readLegacyCreds();
    if (legacy) {
      await cache.hSet(instanceName, 'creds', legacy);
      const copied = await cache.hGetStrict(instanceName, 'creds');
      if (!copied || JSON.stringify(copied, BufferJSON.replacer) !== JSON.stringify(legacy, BufferJSON.replacer)) {
        throw new Error('cópia do crachá para o Redis não confirmada');
      }
      logger.info({ action: 'creds.copiado-do-banco', instanceName });
      creds = copied;
    }
  }
  if (!creds) creds = initAuthCreds();

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
      if (!creds?.me) {
        let stored: any;
        try {
          stored = await cache.hGetStrict(instanceName, 'creds');
        } catch {
          logger.warn({ action: 'creds.save.adiado', motivo: 'redis indisponível', instanceName });
          return;
        }
        if (stored?.me) {
          logger.warn({
            action: 'creds.save.recusado',
            motivo: 'crachá sem pareamento sobre crachá pareado',
            instanceName,
          });
          return;
        }
      }
      return await writeData(creds, 'creds');
    },

    removeCreds,
  };
}
