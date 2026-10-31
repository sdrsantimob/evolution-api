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
