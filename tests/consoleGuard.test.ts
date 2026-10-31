// Nenhuma chave de sessão do WhatsApp sai no log nem vai junto dos erros para o monitor.
// Dado 100% sintético (chaves geradas na hora). Rodar: npx tsx --test tests/consoleGuard.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installConsoleGuard, redactArg } from '../src/utils/consoleGuard';
import { scrubBreadcrumb } from '../src/utils/sentryScrub';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SessionRecord, keyhelper, curve } = require('libsignal');

function sessaoSintetica() {
  const record = new SessionRecord();
  const entry = SessionRecord.createEntry();
  const par = curve.generateKeyPair();
  entry.registrationId = keyhelper.generateRegistrationId();
  entry.currentRatchet = { ephemeralKeyPair: par, lastRemoteEphemeralKey: par.pubKey, previousCounter: 0, rootKey: Buffer.alloc(32, 7) };
  entry.indexInfo = { baseKey: par.pubKey, baseKeyType: 1, closed: -1, used: 1, created: 1, remoteIdentityKey: par.pubKey };
  return { record, entry, par };
}

function capturar(fn: () => void): string {
  const linhas: string[] = [];
  const falso: any = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    falso[m] = (...args: unknown[]) => linhas.push(args.map((a) => (typeof a === 'string' ? a : require('util').inspect(a, { depth: 5 }))).join(' '));
  }
  installConsoleGuard(falso);
  const original = { ...console };
  Object.assign(console, falso);
  try {
    fn();
  } finally {
    Object.assign(console, original);
  }
  return linhas.join('\n');
}

test('a biblioteca de criptografia fecha e abre sessão sem a chave privada aparecer no log', () => {
  const { record, entry, par } = sessaoSintetica();
  const saida = capturar(() => {
    record.setSession(entry);
    record.closeSession(entry);
    record.openSession(entry);
  });
  assert.match(saida, /Closing session:/);
  assert.match(saida, /Opening session:/);
  assert.match(saida, /omitido: dado de sessão/);
  const priv = Buffer.from(par.privKey);
  for (const forma of [priv.toString('hex'), priv.toString('base64'), [...priv.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' ')]) {
    assert.ok(!saida.includes(forma), 'chave privada apareceu no log');
  }
});

test('texto, número, erro e objeto comum passam inalterados', () => {
  const obj = { instance: 'x', state: 'open' };
  const err = new Error('falhou');
  assert.equal(redactArg('Closing session:'), 'Closing session:');
  assert.equal(redactArg(42), 42);
  assert.equal(redactArg(err), err);
  assert.equal(redactArg(obj), obj);
});

test('bytes e credenciais do aparelho, mesmo aninhados, viram aviso', () => {
  assert.notEqual(redactArg(Buffer.from('abc')), Buffer.from('abc'));
  assert.equal(typeof redactArg({ creds: { noiseKey: { private: 'x' } } }), 'string');
  assert.equal(typeof redactArg({ a: { b: { c: new Uint8Array(4) } } }), 'string');
});

test('linha de console guardada pelo monitor de erros sai sem a sessão', () => {
  const { entry } = sessaoSintetica();
  const crumb = { category: 'console', message: 'Closing session: [object Object]', data: { arguments: ['Closing session:', entry] } };
  const limpo = scrubBreadcrumb(crumb);
  assert.equal(limpo.data.arguments[1], '[omitido: dado de sessão]');
  assert.equal(limpo.message, 'Closing session: [omitido: dado de sessão]');
  const outro = { category: 'http', data: { url: '/x' } };
  assert.equal(scrubBreadcrumb(outro as any), outro);
});
