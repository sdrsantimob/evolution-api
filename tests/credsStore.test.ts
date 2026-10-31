// Regras de qual crachá vale e de renovação da cópia de segurança. Sem rede, dado sintético.
// Rodar: npx tsx --test tests/credsStore.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initAuthCreds } from 'baileys';

import { BACKUP_REFRESH_MS, chooseCreds, loadCreds, makeSaveCreds } from '../src/utils/credsStore';

const log = { info: () => {}, warn: () => {} };
const conta = (n = 1) => ({ ...initAuthCreds(), me: { id: `550000000000${n}:1@s.whatsapp.net` } });
const avancar = (c: any, d = 5) => ({ ...c, nextPreKeyId: c.nextPreKeyId + d, firstUnuploadedPreKeyId: c.firstUnuploadedPreKeyId + d });

function memoria(inicial: { redis?: any; db?: any } = {}) {
  const s: any = { redis: inicial.redis ?? null, db: inicial.db ?? null, escritas: { redis: 0, db: 0 }, falha: {} };
  const io = (k: 'redis' | 'db') => ({
    read: async () => {
      if (s.falha[k]) throw new Error(`${k} fora`);
      return s[k];
    },
    write: async (c: any) => {
      if (s.falha[k]) throw new Error(`${k} fora`);
      s[k] = c;
      s.escritas[k]++;
    },
  });
  const copies = { readRedis: io('redis').read, writeRedis: io('redis').write, readDb: io('db').read, writeDb: io('db').write };
  return { s, copies };
}

test('pareada vence sem pareamento; mais nova vence; conflito fica com a principal', () => {
  const a = conta();
  assert.equal(chooseCreds(initAuthCreds(), a, 'redis').from, 'db');
  assert.equal(chooseCreds(a, avancar(a), 'redis').from, 'db');
  assert.equal(chooseCreds(avancar(a), a, 'db').from, 'redis');
  const conflito = { ...a, nextPreKeyId: a.nextPreKeyId + 1, accountSyncCounter: -1 };
  assert.equal(chooseCreds(conflito, a, 'db').from, 'db');
  assert.equal(chooseCreds(conflito, a, 'redis').from, 'redis');
  const outra = conta(2);
  assert.equal(chooseCreds(outra, a, 'db').from, 'db');
});

test('volta à versão antiga e ida de novo: a cópia mais nova pelo conteúdo vence, a outra é atualizada', async () => {
  const base = conta();
  const novaNoBanco = avancar(base); // a versão antiga gravou só no banco
  const { s, copies } = memoria({ redis: base, db: novaNoBanco });
  const usado = await loadCreds(copies, 'redis', log, 'x');
  assert.deepEqual(usado, novaNoBanco);
  assert.deepEqual(s.redis, novaNoBanco);
});

test('cópia de segurança fora do ar não impede abrir quando a principal está pareada', async () => {
  const { s, copies } = memoria({ redis: conta() });
  s.falha.db = true;
  assert.ok(await loadCreds(copies, 'redis', log, 'x'));
});

test('cópia de segurança fora do ar com a principal vazia: não abre (nada de crachá novo)', async () => {
  const { s, copies } = memoria({});
  s.falha.db = true;
  await assert.rejects(loadCreds(copies, 'redis', log, 'x'));
});

test('principal fora do ar: não abre', async () => {
  const { s, copies } = memoria({ db: conta() });
  s.falha.redis = true;
  await assert.rejects(loadCreds(copies, 'redis', log, 'x'));
});

test('modo Redis: cópia de segurança no banco renovada no máximo a cada 24h', async () => {
  let agora = 0;
  const c = conta();
  const { s, copies } = memoria({ redis: c, db: c });
  const salvar = makeSaveCreds(copies, 'redis', log, 'x', () => agora);
  for (let i = 0; i < 50; i++) {
    agora += 60_000;
    await salvar(avancar(c, i + 1));
  }
  assert.equal(s.escritas.redis, 50);
  assert.equal(s.escritas.db, 0);
  agora = BACKUP_REFRESH_MS + 1;
  await salvar(avancar(c, 99));
  assert.equal(s.escritas.db, 1);
  assert.equal(s.db.nextPreKeyId, c.nextPreKeyId + 99);
});

test('modo banco: toda gravação também atualiza o espelho no Redis', async () => {
  const c = conta();
  const { s, copies } = memoria({ redis: c, db: c });
  const salvar = makeSaveCreds(copies, 'db', log, 'x');
  await salvar(avancar(c));
  assert.equal(s.escritas.db, 1);
  assert.equal(s.escritas.redis, 1);
});

test('crachá sem pareamento nunca grava por cima de pareado, nem na principal nem na cópia', async () => {
  const c = conta();
  for (const mode of ['redis', 'db'] as const) {
    const { s, copies } = memoria({ redis: c, db: c });
    await makeSaveCreds(copies, mode, log, 'x', () => BACKUP_REFRESH_MS * 2)(initAuthCreds());
    assert.equal(s.escritas.redis + s.escritas.db, 0, mode);
  }
});
