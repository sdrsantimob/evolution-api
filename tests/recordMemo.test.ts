// Memória curta de conversas e contatos. Rodar: npx tsx --test tests/recordMemo.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RecordMemo, samePicture } from '../src/utils/recordMemo';

test('guarda, distingue "não sei" de "não existe" e esquece ao apagar', () => {
  const m = new RecordMemo<{ id: string } | null>();
  assert.equal(m.get('a'), undefined);
  m.set('a', null);
  assert.equal(m.get('a'), null);
  m.set('a', { id: '1' });
  assert.deepEqual(m.get('a'), { id: '1' });
  m.delete('a');
  assert.equal(m.get('a'), undefined);
});

test('vence pela validade e descarta o mais antigo ao encher', () => {
  let agora = 0;
  const m = new RecordMemo<number>(2, 1000, () => agora);
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3);
  assert.equal(m.get('a'), undefined);
  assert.equal(m.size, 2);
  agora = 1001;
  assert.equal(m.get('b'), undefined);
});

test('foto: mesma imagem com assinatura nova conta como igual; imagem diferente não', () => {
  assert.ok(samePicture('https://cdn/x.jpg?oh=1&oe=2', 'https://cdn/x.jpg?oh=3&oe=4'));
  assert.ok(!samePicture('https://cdn/x.jpg?oh=1', 'https://cdn/y.jpg?oh=1'));
  assert.ok(samePicture(null, undefined));
  assert.ok(!samePicture(null, 'https://cdn/x.jpg'));
});

test('interruptor de reversão desliga a memória sem apagar nada', () => {
  const m = new RecordMemo<number>();
  m.set('a', 1);
  process.env.CONECTOR_MEMORIA_CURTA = 'false';
  assert.equal(m.get('a'), undefined);
  delete process.env.CONECTOR_MEMORIA_CURTA;
  assert.equal(m.get('a'), 1);
});

test('lista completa: ausente = não existe; alterado por outro caminho volta a ler; vence e volta ao normal', () => {
  let agora = 0;
  const m = new RecordMemo<{ id: string } | null>(10, 1000, () => agora);
  assert.ok(m.loadComplete([['a', { id: '1' }]], 5000));
  assert.deepEqual(m.get('a'), { id: '1' });
  assert.equal(m.get('b'), null);
  m.delete('a');
  assert.equal(m.get('a'), undefined);
  m.set('a', { id: '2' });
  assert.deepEqual(m.get('a'), { id: '2' });
  agora = 6000;
  assert.equal(m.isComplete(), false);
  assert.equal(m.get('b'), undefined);
});

test('lista completa que não cabe não vale como completa', () => {
  const m = new RecordMemo<number>(2);
  assert.equal(m.loadComplete([['a', 1], ['b', 2], ['c', 3]], 5000), false);
  assert.equal(m.get('z'), undefined);
});
