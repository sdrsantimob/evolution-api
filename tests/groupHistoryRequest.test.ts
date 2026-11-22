// [WA-70] Pedido de histórico antigo de UM grupo ao celular.
// Dado 100% sintético. Rodar: npx tsx --test tests/groupHistoryRequest.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GROUP_HISTORY_MAX_COUNT,
  GroupHistoryExecutor,
  GroupHistoryGate,
  parseGroupHistoryBody,
} from '../src/utils/groupHistoryRequest';

const NOW = Date.UTC(2026, 10, 22, 12);
const GROUP = '120363000000000001@g.us';
const BODY = { remoteJid: GROUP, id: '3EB0AAAAAAAAAAAAAAAA', fromMe: false, participant: '5500000000001@s.whatsapp.net', timestampMs: NOW - 3_600_000 };

function setup(result: unknown | Error = 'ok', minIntervalMs = 1_000, timeoutMs = 1_000) {
  let clock = NOW;
  const asked: Array<{ count: number; key: unknown; ts: number }> = [];
  const gate = new GroupHistoryGate(minIntervalMs, () => clock, timeoutMs);
  const exec: GroupHistoryExecutor = async (count, key, ts) => {
    asked.push({ count, key, ts });
    if (result instanceof Error) throw result;
    if (result === 'hang') return new Promise(() => undefined);
    return result;
  };
  return { gate, exec, asked, advance: (ms: number) => (clock += ms) };
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
  const written: string[] = [];
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const grab = (...a: unknown[]) => void written.push(a.map(String).join(' '));
  Object.assign(console, { log: grab, info: grab, warn: grab, error: grab, debug: grab });
  process.stdout.write = ((c: unknown) => (written.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => (written.push(String(c)), true)) as typeof process.stderr.write;
  try {
    return { value: await fn(), written: written.join('\n') };
  } finally {
    Object.assign(console, keep);
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

test('pede ao celular só o grupo, com a âncora exata e no máximo 50', async () => {
  const { gate, exec, asked } = setup();
  const r = await gate.run({ ...BODY, count: 500 }, exec, 'error');
  assert.deepEqual(r, { outcome: 'requested' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].count, GROUP_HISTORY_MAX_COUNT);
  assert.deepEqual(asked[0].key, { remoteJid: GROUP, id: BODY.id, fromMe: false, participant: BODY.participant });
  assert.equal(asked[0].ts, BODY.timestampMs);
});

test('recusa conversa de pessoa, lista, canal e status antes de falar com o WhatsApp', async () => {
  for (const remoteJid of [
    '5500000000001@s.whatsapp.net',
    '990000000000001@lid',
    'status@broadcast',
    '120363000000000001@newsletter',
    `${GROUP},5500000000001@s.whatsapp.net`,
    '',
  ]) {
    const { gate, exec, asked } = setup();
    assert.deepEqual(await gate.run({ ...BODY, remoteJid }, exec, 'error'), { outcome: 'invalid' });
    assert.equal(asked.length, 0, remoteJid);
  }
});

test('recusa campo a mais, lista, faltando ou fora do formato', () => {
  const bad: unknown[] = [
    null, [], 'x', [BODY],
    { ...BODY, extra: 1 },
    { ...BODY, remoteJid: [GROUP] },
    { ...BODY, id: 'a/b' },
    { ...BODY, fromMe: 'false' },
    { ...BODY, participant: 'alguem' },
    { ...BODY, timestampMs: Math.floor(NOW / 1000) }, // em segundos
    { ...BODY, timestampMs: NOW + 3 * 86_400_000 }, // no futuro
    { ...BODY, timestampMs: 1.5 },
    { ...BODY, count: 0 },
    { ...BODY, count: '10' },
    { remoteJid: GROUP, id: BODY.id, fromMe: false }, // sem horário
  ];
  for (const b of bad) assert.equal(parseGroupHistoryBody(b, NOW), null, JSON.stringify(b));
  const sem = { ...BODY } as Record<string, unknown>;
  delete sem.participant;
  assert.ok(parseGroupHistoryBody(sem, NOW));
});

test('não pede com o registro detalhado da biblioteca ligado', async () => {
  for (const level of ['trace', 'debug', 'info', undefined, 'qualquer']) {
    const { gate, exec, asked } = setup();
    assert.deepEqual(await gate.run(BODY, exec, level), { outcome: 'unsafe' });
    assert.equal(asked.length, 0);
  }
});

test('sem conexão aberta, não pede', async () => {
  const { gate } = setup();
  assert.deepEqual(await gate.run(BODY, null, 'error'), { outcome: 'offline' });
});

test('um pedido por vez e intervalo mínimo, contado também na falha', async () => {
  const { gate, exec, advance } = setup(new Error('x'), 1_000);
  assert.deepEqual(await gate.run(BODY, exec, 'error'), { outcome: 'failed' });
  assert.deepEqual(await gate.run(BODY, exec, 'error'), { outcome: 'interval' });
  advance(1_001);
  const hang = setup('hang', 1_000, 50);
  const first = hang.gate.run(BODY, hang.exec, 'error');
  assert.deepEqual(await hang.gate.run(BODY, hang.exec, 'error'), { outcome: 'busy' });
  assert.deepEqual(await first, { outcome: 'failed' }); // desistiu sozinho
});

test('nada é escrito em registro e a resposta não leva endereço nem id', async () => {
  const { gate, exec } = setup(new Error(`falhou ${GROUP} ${BODY.id}`));
  const { value, written } = await captureOutput(() => gate.run(BODY, exec, 'error'));
  const ok = setup();
  const { value: v2, written: w2 } = await captureOutput(() => ok.gate.run(BODY, ok.exec, 'error'));
  assert.equal(written + w2, '');
  for (const v of [value, v2]) {
    assert.ok(!JSON.stringify(v).includes(GROUP));
    assert.ok(!JSON.stringify(v).includes(BODY.id));
    assert.deepEqual(Object.keys(v), ['outcome']);
  }
});
