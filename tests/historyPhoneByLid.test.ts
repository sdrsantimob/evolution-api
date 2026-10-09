// [WA-34] Telefone anexado às mensagens do histórico.
// Dado 100% sintético. Rodar: npx tsx --test tests/historyPhoneByLid.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachPhone, buildPhoneByLid, needsPhone } from '../src/utils/historyPhoneByLid';

const LID = '990000000000001@lid';
const PHONE = '5500000000001@s.whatsapp.net';

test('monta o par a partir do formato que a biblioteca entrega no histórico', () => {
  const map = buildPhoneByLid([
    // conversa endereçada pelo identificador novo, com o telefone informado
    { id: LID, lid: undefined, phoneNumber: PHONE },
    // conversa endereçada pelo telefone, com o identificador informado
    { id: '5500000000002@s.whatsapp.net', lid: '990000000000002@lid', phoneNumber: undefined },
    // as duas formas explícitas, com sufixo de aparelho no telefone
    { id: '990000000000003@lid', lid: '990000000000003@lid', phoneNumber: '5500000000003:12@s.whatsapp.net' },
  ]);

  assert.equal(map.get(LID), PHONE);
  assert.equal(map.get('990000000000002@lid'), '5500000000002@s.whatsapp.net');
  assert.equal(map.get('990000000000003@lid'), '5500000000003@s.whatsapp.net', 'telefone sai sem o sufixo de aparelho');
  assert.equal(map.size, 3);
});

test('sem as duas pontas não inventa par', () => {
  const map = buildPhoneByLid([
    { id: LID }, // só o identificador
    { id: PHONE }, // só o telefone
    { id: '120363000000000001@g.us', lid: LID, phoneNumber: undefined }, // grupo com lid, sem telefone
    { id: 'status@broadcast' },
    {},
    { id: null, lid: null, phoneNumber: null },
  ]);
  assert.equal(map.size, 0);
  assert.equal(buildPhoneByLid(undefined).size, 0);
  assert.equal(buildPhoneByLid(null).size, 0);
});

test('só a conversa endereçada pelo identificador novo, e ainda sem telefone, precisa de telefone', () => {
  assert.equal(needsPhone({ remoteJid: LID }), true);
  assert.equal(needsPhone({ remoteJid: LID, remoteJidAlt: PHONE }), false, 'já veio com o telefone');
  assert.equal(needsPhone({ remoteJid: PHONE }), false, 'já é endereçada pelo telefone');
  assert.equal(needsPhone({ remoteJid: '120363000000000001@g.us' }), false, 'grupo');
  assert.equal(needsPhone({ remoteJid: 'status@broadcast' }), false);
  assert.equal(needsPhone({}), false);
  assert.equal(needsPhone(undefined), false);
});

test('anexa o telefone preservando o endereço original da mensagem', () => {
  const key: { remoteJid: string; remoteJidAlt?: string; id: string; fromMe: boolean } = { remoteJid: LID, id: 'm1', fromMe: false };
  assert.equal(attachPhone(key, '5500000000001:3@s.whatsapp.net'), true);
  assert.deepEqual(key, { remoteJid: LID, remoteJidAlt: PHONE, id: 'm1', fromMe: false });
});

test('não anexa quando não há telefone, quando o valor não é telefone ou quando a chave não precisa', () => {
  const semTelefone = { remoteJid: LID };
  assert.equal(attachPhone(semTelefone, null), false);
  assert.equal(attachPhone(semTelefone, undefined), false);
  assert.equal(attachPhone(semTelefone, '990000000000009@lid'), false, 'outro identificador não é telefone');
  assert.equal(attachPhone(semTelefone, '120363000000000001@g.us'), false);
  assert.deepEqual(semTelefone, { remoteJid: LID });

  const jaTem = { remoteJid: LID, remoteJidAlt: PHONE };
  assert.equal(attachPhone(jaTem, '5500000000099@s.whatsapp.net'), false, 'não sobrescreve o que já veio');
  assert.equal(jaTem.remoteJidAlt, PHONE);

  const porTelefone = { remoteJid: PHONE };
  assert.equal(attachPhone(porTelefone, PHONE), false);
  assert.deepEqual(porTelefone, { remoteJid: PHONE });
});

test('o arquivo não escreve em log, banco, cache nem arquivo', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/utils/historyPhoneByLid.ts', import.meta.url), 'utf8');
  const codigo = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.equal(/logger\.|console\.|process\.std|prisma|writeFile|fs\.|cache/i.test(codigo), false);
});
