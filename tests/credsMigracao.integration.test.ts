// Crachá da sessão do WhatsApp: cópia do banco do conector para o Redis, sem perda e sem sobrescrita.
// Usa Redis e Postgres LOCAIS e o mesmo código de gravação da produção. Dado 100% sintético.
// Rodar (só com os dois serviços locais de teste):
//   TEST_LOCAL_STACK=1 DATABASE_PROVIDER=postgresql DATABASE_CONNECTION_URI=... CACHE_REDIS_ENABLED=true \
//   CACHE_REDIS_URI=redis://127.0.0.1:6391 CACHE_REDIS_PREFIX_KEY=evolution-teste DATABASE_SAVE_DATA_INSTANCE=true \
//   npx tsx --test tests/credsMigracao.integration.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

const enabled = process.env.TEST_LOCAL_STACK === '1';

test('crachá: cópia, falhas, sobrescrita e reversão', { skip: !enabled && 'sem Redis/Postgres locais' }, async (t) => {
  const { BufferJSON, initAuthCreds } = await import('baileys');
  const { CacheEngine } = await import('../src/cache/cacheengine');
  const { CacheService } = await import('../src/api/services/cache.service');
  const { configService } = await import('../src/config/env.config');
  const { prismaRepository } = await import('../src/api/server.module');
  const prisma = await import('../src/utils/use-multi-file-auth-state-prisma');
  const { useMultiFileAuthStateRedisDb } = await import('../src/utils/use-multi-file-auth-state-redis-db');

  const cache = new CacheService(new CacheEngine(configService, 'instance').getEngine());
  await new Promise((r) => setTimeout(r, 300));
  const same = (a: any, b: any) => JSON.stringify(a, BufferJSON.replacer) === JSON.stringify(b, BufferJSON.replacer);
  const paired = () => ({ ...initAuthCreds(), me: { id: '5500000000001:1@s.whatsapp.net', name: 'Teste' } });
  // Grava no banco exatamente como o modo atual grava (writeData -> saveKey).
  const seedDb = async (id: string, creds: any) => {
    await prisma.saveKey(id, JSON.stringify(creds, BufferJSON.replacer));
    assert.ok(await prisma.readCredsFromDatabase(id), 'preparo: crachá não foi gravado no banco');
  };
  const ids: string[] = [];
  // O crachá no banco pertence a um número cadastrado (chave estrangeira): cria o cadastro sintético.
  const newId = async () => {
    const id = randomUUID();
    ids.push(id);
    await prismaRepository.instance.create({ data: { id, name: `teste-${id}` } });
    return id;
  };
  after(async () => {
    for (const id of ids) {
      await cache.delete(id);
      await prismaRepository.session.deleteMany({ where: { sessionId: id } });
      await prismaRepository.instance.deleteMany({ where: { id } });
    }
    await prismaRepository.$disconnect();
  });

  const dbCopy = (id: string) => ({
    read: () => prisma.readCredsFromDatabase(id),
    write: (c: any) => prisma.writeCredsToDatabase(id, c),
  });
  const redisMode = (id: string) => useMultiFileAuthStateRedisDb(id, cache, dbCopy(id));
  const dbMode = (id: string) => prisma.default(id, cache);
  const ahead = (c: any, d: number) => ({ ...c, nextPreKeyId: c.nextPreKeyId + d, firstUnuploadedPreKeyId: c.firstUnuploadedPreKeyId + d });

  await t.test('A: fase 1 (modo banco) -> abre com o crachá do banco e cria o espelho no Redis', async () => {
    const id = await newId();
    const original = paired();
    await seedDb(id, original);
    await cache.hSet(id, 'pre-key-1', { keyPair: { private: Buffer.alloc(32, 1) } });
    const st = await dbMode(id);
    assert.ok(same(st.state.creds, original));
    assert.ok(Buffer.isBuffer(st.state.creds.noiseKey.private));
    assert.ok(same(await cache.hGetStrict(id, 'creds'), original), 'espelho no Redis diferente');
    assert.ok(same(await prisma.readCredsFromDatabase(id), original), 'banco alterado');
    assert.ok(await cache.hGet(id, 'pre-key-1'), 'chave existente no Redis se perdeu');
  });

  await t.test('B: fase 3 sem espelho (Redis vazio) -> copia do banco por dentro, idêntico', async () => {
    const id = await newId();
    const original = paired();
    await seedDb(id, original);
    const st = await redisMode(id);
    assert.ok(same(st.state.creds, original));
    assert.ok(same(await cache.hGetStrict(id, 'creds'), original));
    assert.ok(same(await prisma.readCredsFromDatabase(id), original));
  });

  await t.test('C: ida e volta completa -> fase 1, fase 3 com uso, volta ao modo banco: vale sempre o mais novo', async () => {
    const id = await newId();
    const original = paired();
    await seedDb(id, original);
    await dbMode(id); // fase 1
    const st = await redisMode(id); // fase 3
    Object.assign(st.state.creds, ahead(original, 30));
    await st.saveCreds(); // uso no Redis (a cópia no banco fica para trás, até 24h)
    const back = await dbMode(id); // reversão
    assert.equal(back.state.creds.nextPreKeyId, original.nextPreKeyId + 30, 'reversão pegou o crachá velho');
    assert.equal((await prisma.readCredsFromDatabase(id)).nextPreKeyId, original.nextPreKeyId + 30, 'banco não foi atualizado na reversão');
  });

  await t.test('D: volta à versão ANTIGA do conector (grava só no banco) e ida de novo -> vale o do banco', async () => {
    const id = await newId();
    const original = paired();
    await seedDb(id, original);
    await redisMode(id);
    const pelaVersaoAntiga = ahead(original, 50);
    await seedDb(id, pelaVersaoAntiga); // a versão antiga só conhece o banco
    const st = await redisMode(id);
    assert.equal(st.state.creds.nextPreKeyId, pelaVersaoAntiga.nextPreKeyId, 'ida de novo pegou o Redis velho');
    assert.equal((await cache.hGetStrict(id, 'creds')).nextPreKeyId, pelaVersaoAntiga.nextPreKeyId);
  });

  await t.test('E: Redis falha na leitura -> não abre, não cria crachá novo, não grava nada', async () => {
    const id = await newId();
    await seedDb(id, paired());
    const broken: any = Object.create(cache);
    broken.hGetStrict = async () => {
      throw new Error('redis fora');
    };
    let wrote = false;
    broken.hSet = async () => {
      wrote = true;
    };
    await assert.rejects(useMultiFileAuthStateRedisDb(id, broken, dbCopy(id)));
    assert.equal(wrote, false);
  });

  await t.test('F: banco fora com Redis pareado -> abre pelo Redis; banco fora com Redis vazio -> não abre', async () => {
    const id = await newId();
    await cache.hSet(id, 'creds', paired());
    const fora = { read: async () => Promise.reject(new Error('banco fora')), write: async () => Promise.reject(new Error('banco fora')) };
    const st = await useMultiFileAuthStateRedisDb(id, cache, fora);
    assert.ok(st.state.creds.me);
    const vazio = await newId();
    await assert.rejects(useMultiFileAuthStateRedisDb(vazio, cache, fora));
    assert.equal(await cache.hGetStrict(vazio, 'creds'), null);
  });

  await t.test('G: nada em lugar nenhum -> crachá novo (QR), gravado só no saveCreds', async () => {
    const id = await newId();
    const st = await redisMode(id);
    assert.equal(st.state.creds.me, undefined);
    assert.equal(await cache.hGetStrict(id, 'creds'), null);
    await st.saveCreds();
    assert.ok(await cache.hGetStrict(id, 'creds'));
  });

  await t.test('H: crachá sem pareamento nunca grava por cima de pareado (modo Redis e modo banco)', async () => {
    const id = await newId();
    const fresh = await redisMode(id);
    const real = paired();
    await cache.hSet(id, 'creds', real);
    await fresh.saveCreds();
    assert.ok(same(await cache.hGetStrict(id, 'creds'), real));

    const id2 = await newId();
    const fresh2 = await dbMode(id2);
    await seedDb(id2, real);
    await fresh2.saveCreds();
    assert.ok(same(await prisma.readCredsFromDatabase(id2), real));
  });

  await t.test('I: pareamento novo (com aparelho) grava normalmente', async () => {
    const id = await newId();
    const st = await redisMode(id);
    (st.state.creds as any).me = { id: '5500000000002:1@s.whatsapp.net' };
    await st.saveCreds();
    assert.equal((await cache.hGetStrict(id, 'creds')).me.id, '5500000000002:1@s.whatsapp.net');
  });
});
