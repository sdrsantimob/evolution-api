// Onde as gravações agrupadas ficam guardadas até irem para o banco: uma gaveta por número no Redis
// (`<prefixo>:gravacoes:<id do número>`), separada da gaveta da sessão.
import { RedisCache } from '@cache/rediscache';
import { CacheConf, configService } from '@config/env.config';

import { PendingStore } from './writeBehind';

const TIMEOUT_MS = 3000;

let engine: RedisCache | null = null;
function redis(): RedisCache | null {
  const conf = configService.get<CacheConf>('CACHE')?.REDIS;
  if (!conf?.ENABLED) return null;
  if (!engine) engine = new RedisCache(configService, 'gravacoes');
  return engine;
}

// Redis travado não pode travar o atendimento: passou do limite, conta como indisponível.
// Espera até 1 s o Redis ficar pronto (ex.: logo após a partida). Se ele já estava fora há pouco,
// não espera de novo por 30 s: a gravação vai direto ao banco sem atrasar as mensagens.
let downSince = 0;
async function ready(r: RedisCache): Promise<boolean> {
  if (r.isReady()) return true;
  if (downSince && Date.now() - downSince < 30_000) return false;
  for (let i = 0; i < 10 && !r.isReady(); i++) await new Promise((x) => setTimeout(x, 100));
  downSince = r.isReady() ? 0 : Date.now();
  return r.isReady();
}

async function limited<T>(work: () => Promise<T>): Promise<T> {
  const r = redis();
  if (!r || !(await ready(r))) throw new Error('redis indisponível');
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('redis sem resposta')), TIMEOUT_MS);
    work().then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export function redisPendingStore(instanceId: string): PendingStore | null {
  if (!redis()) return null;
  return {
    save: (field, value) => limited(() => redis().hSetRaw(instanceId, field, value)),
    remove: (field) => limited(() => redis().hDelRaw(instanceId, field)),
    loadAll: () => limited(() => redis().hGetAllRaw(instanceId)),
    clear: () => limited(() => redis().delRaw(instanceId)),
  };
}
