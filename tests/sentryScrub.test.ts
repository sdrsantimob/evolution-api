// [WA-37] O monitor de erros não leva corpo de requisição nem chave de acesso.
// Dado 100% sintético. Rodar: npx tsx --test tests/sentryScrub.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { scrubRequest } from '../src/utils/sentryScrub';

const NUMBER = '5500000000001';

test('apaga corpo, consulta, cookies e cabeçalhos de acesso; o resto do evento fica', () => {
  const event = {
    event_id: 'abc',
    transaction: 'POST /chat/findLid/:instanceName',
    request: {
      method: 'POST',
      url: 'http://motor.invalid/chat/findLid/conexao-teste',
      data: { number: NUMBER },
      query_string: `number=${NUMBER}`,
      cookies: { sessao: 'valor' },
      headers: {
        apikey: 'chave-sintetica',
        ApiKey: 'chave-sintetica-2',
        Authorization: 'Bearer chave-sintetica-3',
        cookie: 'sessao=valor',
        'content-type': 'application/json',
        'user-agent': 'teste',
      },
    },
  };

  const out = scrubRequest(event);
  const text = JSON.stringify(out);

  assert.equal(out, event, 'devolve o mesmo evento, já limpo');
  assert.ok(!text.includes(NUMBER), 'o número não sai');
  assert.ok(!text.includes('chave-sintetica'), 'a chave de acesso não sai');
  assert.ok(!text.includes('sessao'), 'cookie não sai');
  assert.deepEqual(out.request.headers, { 'content-type': 'application/json', 'user-agent': 'teste' });
  assert.equal(out.request.method, 'POST');
  assert.equal(out.transaction, 'POST /chat/findLid/:instanceName');
});

test('corpo como texto também é apagado', () => {
  const out = scrubRequest({ request: { data: JSON.stringify({ number: NUMBER }) } });
  assert.ok(!JSON.stringify(out).includes(NUMBER));
});

test('evento sem requisição passa intacto', () => {
  assert.deepEqual(scrubRequest({ message: 'x' } as { message: string; request?: never }), { message: 'x' });
  assert.deepEqual(scrubRequest({ request: undefined }), { request: undefined });
});

test('o monitor é iniciado com a limpeza nos dois tipos de evento', () => {
  const source = readFileSync(new URL('../src/utils/instrumentSentry.ts', import.meta.url), 'utf8');
  assert.match(source, /beforeSend:\s*\(event\)\s*=>\s*scrubRequest\(event\)/);
  assert.match(source, /beforeSendTransaction:\s*\(event\)\s*=>\s*scrubRequest\(event\)/);
  assert.match(source, /sendDefaultPii:\s*false/);
});
