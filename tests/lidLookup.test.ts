// [WA-37] Consulta "número → identificador" ao WhatsApp, um número por vez.
// Dado 100% sintético. Rodar: npx tsx --test tests/lidLookup.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { USyncQuery } from 'baileys';

import { LID_LOOKUP_MIN_INTERVAL_MS, LidLookupGate, USyncAnswer } from '../src/utils/lidLookup';

const NUMBER = '5500000000001';
const PHONE = `${NUMBER}@s.whatsapp.net`;
const LID = '990000000000001@lid';

// Um relógio de mentira e um "WhatsApp" de mentira, que guarda as perguntas recebidas.
function setup(answer: USyncAnswer | Error | (() => Promise<USyncAnswer>), minIntervalMs = 1_000) {
  let clock = 1_000_000;
  const asked: USyncQuery[] = [];
  const gate = new LidLookupGate(minIntervalMs, () => clock);
  const exec = async (query: USyncQuery) => {
    asked.push(query);
    if (typeof answer === 'function') return answer();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gate, exec, asked, advance: (ms: number) => (clock += ms) };
}

// Tudo o que o processo escreveria enquanto `fn` roda (registro e saída direta).
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
  const written: string[] = [];
  const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = levels.map((level) => console[level]);
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return true;
  };
  levels.forEach((level) => (console[level] = (...args: unknown[]) => void written.push(JSON.stringify(args))));
  process.stdout.write = grab as typeof process.stdout.write;
  process.stderr.write = grab as typeof process.stderr.write;
  try {
    return { value: await fn(), written: written.join('\n') };
  } finally {
    levels.forEach((level, i) => (console[level] = originals[i]));
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

test('pergunta por UM número, só o identificador, e devolve o par', async () => {
  const { gate, exec, asked } = setup({ list: [{ id: PHONE, lid: LID }] });

  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'found', lid: LID });

  assert.equal(asked.length, 1);
  assert.equal(asked[0].users.length, 1);
  assert.equal(asked[0].users[0].id, PHONE);
  assert.equal(asked[0].users[0].phone, undefined);
  assert.deepEqual(
    asked[0].protocols.map((p) => p.name),
    ['lid'],
  );
  assert.equal(asked[0].mode, 'query');
});

test('identificador com sufixo de aparelho volta sem o sufixo', async () => {
  const { gate, exec } = setup({ list: [{ id: PHONE, lid: '990000000000001:7@lid' }] });
  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'found', lid: LID });
});

test('sem par, nada é devolvido', async (t) => {
  const cases: Array<[string, USyncAnswer]> = [
    ['lista vazia', { list: [] }],
    ['sem lista', {}],
    ['número sem identificador', { list: [{ id: PHONE }] }],
    ['resposta sobre OUTRO número', { list: [{ id: '5500000000002@s.whatsapp.net', lid: LID }] }],
    ['identificador que não é identificador', { list: [{ id: PHONE, lid: '5500000000009@s.whatsapp.net' }] }],
    ['identificador que não é texto', { list: [{ id: PHONE, lid: 42 }] }],
  ];
  for (const [name, answer] of cases) {
    await t.test(name, async () => {
      const { gate, exec } = setup(answer);
      assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'not_found' });
    });
  }
});

test('o que não é UM número só de dígitos é recusado sem falar com o WhatsApp', async (t) => {
  const invalid: unknown[] = [
    undefined,
    null,
    '',
    5500000000001,
    [NUMBER],
    { number: NUMBER },
    `${NUMBER},5500000000002`,
    `${NUMBER} 5500000000002`,
    PHONE,
    LID,
    `+${NUMBER}`,
    '55000',
    '5500000000001000000',
  ];
  for (const value of invalid) {
    await t.test(JSON.stringify(value) ?? 'undefined', async () => {
      const { gate, exec, asked } = setup({ list: [{ id: PHONE, lid: LID }] });
      assert.deepEqual(await gate.run(value, exec), { outcome: 'invalid' });
      assert.equal(asked.length, 0);
    });
  }
});

test('sem conexão aberta não consulta e não gasta o intervalo', async () => {
  const { gate, exec, asked } = setup({ list: [{ id: PHONE, lid: LID }] });
  assert.deepEqual(await gate.run(NUMBER, null), { outcome: 'offline' });
  assert.deepEqual(await gate.run(NUMBER, undefined), { outcome: 'offline' });
  assert.equal(asked.length, 0);
  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'found', lid: LID });
});

test('intervalo mínimo entre consultas da mesma conexão', async () => {
  const { gate, exec, asked, advance } = setup({ list: [{ id: PHONE, lid: LID }] }, 1_000);

  assert.equal((await gate.run(NUMBER, exec)).outcome, 'found');
  assert.deepEqual(await gate.run('5500000000002', exec), { outcome: 'interval' });
  advance(999);
  assert.deepEqual(await gate.run('5500000000002', exec), { outcome: 'interval' });
  assert.equal(asked.length, 1);

  advance(1);
  assert.equal((await gate.run(NUMBER, exec)).outcome, 'found');
  assert.equal(asked.length, 2);
});

test('consulta que falha também gasta o intervalo (falha não vira repetição)', async () => {
  const { gate, exec, asked, advance } = setup(new Error('boom'), 1_000);
  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'failed' });
  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'interval' });
  advance(1_000);
  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'failed' });
  assert.equal(asked.length, 2);
});

test('uma consulta por vez', async () => {
  let release: (answer: USyncAnswer) => void = () => undefined;
  const pending = new Promise<USyncAnswer>((resolve) => (release = resolve));
  const { gate, exec, asked } = setup(() => pending, 0);

  const first = gate.run(NUMBER, exec);
  assert.deepEqual(await gate.run('5500000000002', exec), { outcome: 'busy' });
  release({ list: [{ id: PHONE, lid: LID }] });
  assert.deepEqual(await first, { outcome: 'found', lid: LID });
  assert.equal(asked.length, 1);

  // Terminada a primeira, a porta volta a abrir.
  assert.equal((await gate.run(NUMBER, exec)).outcome, 'found');
});

test('cada conexão tem a própria porta', async () => {
  const a = setup({ list: [{ id: PHONE, lid: LID }] });
  const b = setup({ list: [{ id: PHONE, lid: LID }] });
  assert.equal((await a.gate.run(NUMBER, a.exec)).outcome, 'found');
  assert.equal((await b.gate.run(NUMBER, b.exec)).outcome, 'found');
});

test('resposta sem resultado do WhatsApp é falha, não "sem identificador"', async () => {
  const { gate, exec } = setup(undefined);
  assert.deepEqual(await gate.run(NUMBER, exec), { outcome: 'failed' });
});

test('o intervalo de fábrica é de pelo menos 30 segundos', () => {
  assert.ok(LID_LOOKUP_MIN_INTERVAL_MS >= 30_000);
});

test('nada é escrito em registro e nada do contato fica guardado na porta', async () => {
  const error = new Error(`falha ao consultar ${PHONE} / ${LID}`);
  const scenarios: Array<[USyncAnswer | Error, unknown]> = [
    [{ list: [{ id: PHONE, lid: LID }] }, NUMBER],
    [{ list: [] }, NUMBER],
    [error, NUMBER],
    [{ list: [{ id: PHONE, lid: LID }] }, `${NUMBER},5500000000002`],
  ];

  for (const [answer, input] of scenarios) {
    const { gate, exec } = setup(answer, 1_000);
    const { value, written } = await captureOutput(async () => {
      const first = await gate.run(input, exec);
      const second = await gate.run(input, exec); // recusada pelo intervalo (ou inválida de novo)
      return [first, second];
    });

    assert.equal(written, '', 'a consulta não pode escrever nada');
    for (const result of value) {
      assert.deepEqual(
        Object.keys(result).filter((key) => key !== 'outcome' && key !== 'lid'),
        [],
      );
      if (result.outcome !== 'found') assert.equal(result.lid, undefined);
    }
    // O que sobra na memória da porta: a hora da última consulta e se há uma em andamento.
    const kept = JSON.stringify(gate);
    assert.ok(!kept.includes(NUMBER), 'o número não fica na porta');
    assert.ok(!kept.includes('990000000000001'), 'o identificador não fica na porta');
    assert.ok(!kept.includes('falha ao consultar'), 'a mensagem de erro não fica na porta');
  }
});
