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

  await t.test('A: banco tem o crachá, Redis vazio -> copia idêntico, banco fica como cópia de segurança', async () => {
    const id = await newId();
    const original = paired();
    await seedDb(id, original);
    await cache.hSet(id, 'pre-key-1', { keyPair: { private: Buffer.alloc(32, 1) } });
    let reads = 0;
    const st = await useMultiFileAuthStateRedisDb(id, cache, () => {
      reads++;
      return prisma.readCredsFromDatabase(id);
    });
    assert.equal(reads, 1);
    assert.ok(same(st.state.creds, original), 'crachá em uso diferente do original');
    assert.ok(Buffer.isBuffer(st.state.creds.noiseKey.private));
    assert.ok(same(await cache.hGetStrict(id, 'creds'), original), 'crachá no Redis diferente do original');
    assert.ok(same(await prisma.readCredsFromDatabase(id), original), 'cópia do banco foi alterada');
    assert.ok(await cache.hGet(id, 'pre-key-1'), 'chave já existente no Redis se perdeu');
    const again = await useMultiFileAuthStateRedisDb(id, cache, () => {
      reads++;
      return prisma.readCredsFromDatabase(id);
    });
    assert.equal(reads, 1, 'segunda partida voltou a ler o banco');
    assert.ok(same(again.state.creds, original));
  });

  await t.test('B: reversão -> o modo anterior lê o mesmo crachá e as mesmas chaves', async () => {
    const id = await newId();
    const original = paired();
    await seedDb(id, original);
    await useMultiFileAuthStateRedisDb(id, cache, () => prisma.readCredsFromDatabase(id));
    const back = await prisma.default(id, cache);
    assert.ok(same(back.state.creds, original));
  });

  await t.test('C: Redis falha na leitura -> não abre, não cria crachá novo, não grava nada', async () => {
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
    await assert.rejects(useMultiFileAuthStateRedisDb(id, broken, () => prisma.readCredsFromDatabase(id)));
    assert.equal(wrote, false);
  });

  await t.test('D: banco falha na leitura -> não abre, não cria crachá novo', async () => {
    const id = await newId();
    await assert.rejects(
      useMultiFileAuthStateRedisDb(id, cache, async () => {
        throw new Error('banco fora');
      }),
    );
    assert.equal(await cache.hGetStrict(id, 'creds'), null);
  });

  await t.test('E: nada em lugar nenhum -> crachá novo (QR), gravado só no saveCreds', async () => {
    const id = await newId();
    const st = await useMultiFileAuthStateRedisDb(id, cache, () => prisma.readCredsFromDatabase(id));
    assert.equal(st.state.creds.me, undefined);
    assert.equal(await cache.hGetStrict(id, 'creds'), null);
    await st.saveCreds();
    assert.ok(await cache.hGetStrict(id, 'creds'));
  });

  await t.test('F: crachá sem pareamento nunca grava por cima de crachá pareado (Redis)', async () => {
    const id = await newId();
    const fresh = await useMultiFileAuthStateRedisDb(id, cache, () => prisma.readCredsFromDatabase(id));
    const real = paired();
    await cache.hSet(id, 'creds', real);
    await fresh.saveCreds();
    assert.ok(same(await cache.hGetStrict(id, 'creds'), real), 'crachá pareado foi sobrescrito');
  });

  await t.test('G: o mesmo vale no modo atual (banco)', async () => {
    const id = await newId();
    const fresh = await prisma.default(id, cache);
    const real = paired();
    await seedDb(id, real);
    await fresh.saveCreds();
    assert.ok(same(await prisma.readCredsFromDatabase(id), real), 'crachá pareado foi sobrescrito no banco');
  });

  await t.test('H: pareamento novo (com aparelho) grava normalmente', async () => {
    const id = await newId();
    const st = await useMultiFileAuthStateRedisDb(id, cache, () => prisma.readCredsFromDatabase(id));
    await cache.hSet(id, 'creds', initAuthCreds());
    (st.state.creds as any).me = { id: '5500000000002:1@s.whatsapp.net' };
    await st.saveCreds();
    assert.equal((await cache.hGetStrict(id, 'creds')).me.id, '5500000000002:1@s.whatsapp.net');
  });
});
