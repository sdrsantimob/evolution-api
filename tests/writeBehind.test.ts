// Gravações agrupadas: soma na ordem, repetível, sem corrida, sem perda com Redis ou banco fora.
// Sem rede, dado sintético. Rodar: npx tsx --test tests/writeBehind.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergePending, PendingWrite, WriteBehind } from '../src/utils/writeBehind';

const log = { info: () => {}, warn: () => {} };
const on = { enabled: () => true, intervalMs: () => 60_000 };

function cenario(opts: { redisFora?: boolean; bancoFora?: boolean } = {}) {
  const redis = new Map<string, string>();
  const banco = new Map<string, any>();
  const estado: any = { redisFora: !!opts.redisFora, bancoFora: !!opts.bancoFora, gravacoes: 0, lentidao: null as null | Promise<void> };
  const store = {
    save: async (f: string, v: string) => {
      if (estado.redisFora) throw new Error('redis fora');
      redis.set(f, v);
    },
    remove: async (f: string) => {
      if (estado.redisFora) throw new Error('redis fora');
      redis.delete(f);
    },
    loadAll: async () => {
      if (estado.redisFora) throw new Error('redis fora');
      return Object.fromEntries(redis);
    },
    clear: async () => void redis.clear(),
  };
  const aplica = async (e: PendingWrite) => {
    if (estado.lentidao) await estado.lentidao;
    if (estado.bancoFora) throw new Error('banco fora');
    estado.gravacoes++;
    const k = `${e.kind}:${e.remoteJid}`;
    const atual = banco.get(k);
    banco.set(k, atual ? { ...atual, ...e.update } : { ...(e.create ?? {}), ...e.update });
  };
  const exec = { contact: aplica, chat: aplica };
  return { redis, banco, estado, store, exec, nova: () => new WriteBehind(store, exec, log, on) };
}

test('soma na ordem de chegada; criar mantém o 1º id e o nome não é apagado por mensagem enviada', () => {
  const a: PendingWrite = { kind: 'contact', remoteJid: 'x', create: { pushName: 'Ana' }, update: { pushName: 'Ana' }, v: 1 };
  const b: PendingWrite = { kind: 'contact', remoteJid: 'x', create: { pushName: '' }, update: { profilePicUrl: 'p' }, v: 2 };
  const m = mergePending(a, b);
  assert.deepEqual(m.update, { pushName: 'Ana', profilePicUrl: 'p' });
  assert.equal(m.create.pushName, 'Ana');
  const c1: PendingWrite = { kind: 'chat', remoteJid: 'y', create: { id: 'id1', name: 'A' }, update: {}, v: 1 };
  const c2: PendingWrite = { kind: 'chat', remoteJid: 'y', create: { id: 'id2', name: 'B' }, update: { unreadMessages: 0 }, v: 2 };
  assert.equal(mergePending(c1, c2).create.id, 'id1');
});

test('agrupa: nada vai ao banco até o ciclo; o ciclo grava o estado final uma vez por registro', async () => {
  const s = cenario();
  const w = s.nova();
  for (let i = 0; i < 10; i++) await w.enqueue('contact', 'x', { pushName: `n${i}` }, { pushName: `n${i}` });
  assert.equal(s.estado.gravacoes, 0);
  assert.equal(s.redis.size, 1);
  await w.flush();
  assert.equal(s.estado.gravacoes, 1);
  assert.equal(s.banco.get('contact:x').pushName, 'n9');
  assert.equal(s.redis.size, 0);
  assert.equal(w.size, 0);
});

test('repetível: gravar de novo a mesma pendente dá o mesmo resultado', async () => {
  const s = cenario();
  const w = s.nova();
  await w.enqueue('chat', 'c', { id: 'i', name: 'A' }, { unreadMessages: 0 });
  const [e] = w.entries();
  await s.exec.chat(e);
  await s.exec.chat(e);
  await w.flush();
  assert.deepEqual(s.banco.get('chat:c'), { id: 'i', name: 'A', unreadMessages: 0 });
});

test('reinício do conector: as pendentes guardadas no Redis voltam e são gravadas', async () => {
  const s = cenario();
  await s.nova().enqueue('contact', 'x', { pushName: 'Ana' }, { pushName: 'Ana' }); // processo "morre" aqui
  assert.equal(s.banco.size, 0);
  const depois = s.nova();
  await depois.recover();
  assert.equal(s.banco.get('contact:x').pushName, 'Ana');
  assert.equal(s.redis.size, 0);
});

test('Redis fora: grava direto no banco na hora (nada fica só na memória)', async () => {
  const s = cenario({ redisFora: true });
  const w = s.nova();
  await w.enqueue('contact', 'x', { pushName: 'Ana' }, { pushName: 'Ana' });
  assert.equal(s.banco.get('contact:x').pushName, 'Ana');
  assert.equal(w.size, 0);
});

test('banco fora no ciclo: pendente fica guardada e é gravada quando o banco volta', async () => {
  const s = cenario();
  const w = s.nova();
  await w.enqueue('contact', 'x', { pushName: 'Ana' }, { pushName: 'Ana' });
  s.estado.bancoFora = true;
  await w.flush();
  assert.equal(w.size, 1);
  assert.equal(s.redis.size, 1);
  s.estado.bancoFora = false;
  await w.flush();
  assert.equal(s.banco.get('contact:x').pushName, 'Ana');
  assert.equal(s.redis.size, 0);
});

test('Redis e banco fora: fica na memória e é gravada no próximo ciclo', async () => {
  const s = cenario({ redisFora: true, bancoFora: true });
  const w = s.nova();
  await w.enqueue('contact', 'x', { pushName: 'Ana' }, { pushName: 'Ana' });
  assert.equal(w.size, 1);
  s.estado.bancoFora = false;
  await w.flush();
  assert.equal(s.banco.get('contact:x').pushName, 'Ana');
});

test('sem corrida: mudança que chega durante a gravação não se perde', async () => {
  const s = cenario();
  const w = s.nova();
  await w.enqueue('contact', 'x', { pushName: 'A' }, { pushName: 'A' });
  let solta: () => void = () => {};
  s.estado.lentidao = new Promise<void>((r) => (solta = r));
  const rodada = w.flush();
  await w.enqueue('contact', 'x', { pushName: 'B' }, { pushName: 'B' });
  s.estado.lentidao = null;
  solta();
  await rodada;
  assert.equal(w.size, 1, 'a mudança B foi apagada junto com a A');
  await w.flush();
  assert.equal(s.banco.get('contact:x').pushName, 'B');
  assert.equal(s.redis.size, 0);
});

test('desligado: grava na hora e ainda recupera pendentes antigas (desligar não perde nada)', async () => {
  const s = cenario();
  await s.nova().enqueue('contact', 'x', { pushName: 'Ana' }, { pushName: 'Ana' });
  const off = new WriteBehind(s.store, s.exec, log, { enabled: () => false, intervalMs: () => 60_000 });
  await off.recover();
  assert.equal(s.banco.get('contact:x').pushName, 'Ana');
  await off.enqueue('contact', 'y', { pushName: 'Bia' }, { pushName: 'Bia' });
  assert.equal(s.banco.get('contact:y').pushName, 'Bia');
  assert.equal(s.redis.size, 0);
});

test('exclusão cancela a pendente; número excluído descarta tudo', async () => {
  const s = cenario();
  const w = s.nova();
  await w.enqueue('chat', 'c', { id: 'i' }, {});
  await w.cancel('chat', 'c');
  await w.flush();
  assert.equal(s.banco.size, 0);
  await w.enqueue('contact', 'x', { pushName: 'Ana' }, {});
  await w.discard();
  assert.equal(s.redis.size, 0);
  assert.equal(w.size, 0);
});
