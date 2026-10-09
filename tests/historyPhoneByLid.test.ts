// [WA-34] Telefone anexado às mensagens do histórico.
// Dado 100% sintético. Rodar: npx tsx --test tests/historyPhoneByLid.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachPhone, buildPhoneByLid, HistoryPhoneBook, needsPhone } from '../src/utils/historyPhoneByLid';

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

test('valor que não é texto não derruba o pacote', () => {
  const estranho = [{ id: 123, lid: {}, phoneNumber: [] }, null, undefined, 'texto', { id: LID, phoneNumber: PHONE }];
  const map = buildPhoneByLid(estranho as never);
  assert.equal(map.size, 1);
  assert.equal(map.get(LID), PHONE);
  assert.equal(buildPhoneByLid('nao-e-lista' as never).size, 0);
});

// A biblioteca só entrega o contato sem nome no PRIMEIRO pacote em que a conversa aparece.
test('o par do primeiro pacote vale para as mensagens dos pacotes seguintes', async () => {
  const livro = new HistoryPhoneBook();

  // pacote 1: traz o par, e uma mensagem da conversa
  assert.equal(livro.remember([{ id: LID, phoneNumber: PHONE }]), 1);
  const m1 = { remoteJid: LID } as { remoteJid: string; remoteJidAlt?: string };
  attachPhone(m1, await livro.phoneFor(m1.remoteJid));
  assert.equal(m1.remoteJidAlt, PHONE);

  // pacote 2: o contato já não vem; a mensagem da mesma conversa continua recebendo o telefone
  assert.equal(livro.remember([]), 0);
  const m2 = { remoteJid: LID } as { remoteJid: string; remoteJidAlt?: string };
  attachPhone(m2, await livro.phoneFor(m2.remoteJid));
  assert.equal(m2.remoteJidAlt, PHONE);

  // conexão encerrada: esquece tudo
  livro.clear();
  assert.equal(livro.size, 0);
  assert.equal(await livro.phoneFor(LID), null);
});

test('sem par no pacote, consulta o mapa da sessão — uma vez por endereço dentro do pacote', async () => {
  const livro = new HistoryPhoneBook();
  const consultas: string[] = [];
  const mapaDaSessao = async (lid: string) => {
    consultas.push(lid);
    return lid === LID ? '5500000000001:0@s.whatsapp.net' : null; // a biblioteca devolve com sufixo de aparelho
  };
  const semPar = new Set<string>();

  assert.equal(await livro.phoneFor(LID, mapaDaSessao, semPar), PHONE, 'sufixo de aparelho é removido');
  assert.equal(await livro.phoneFor(LID, mapaDaSessao, semPar), PHONE);
  assert.equal(consultas.length, 1, 'achou uma vez, lembrou');

  const outro = '990000000000777@lid';
  assert.equal(await livro.phoneFor(outro, mapaDaSessao, semPar), null);
  assert.equal(await livro.phoneFor(outro, mapaDaSessao, semPar), null);
  assert.equal(consultas.filter((c) => c === outro).length, 1, '"não sei" não é perguntado de novo no mesmo pacote');

  // no pacote seguinte (conjunto novo), o "não sei" pode ser perguntado outra vez
  assert.equal(await livro.phoneFor(outro, mapaDaSessao, new Set()), null);
  assert.equal(consultas.filter((c) => c === outro).length, 2);
});

test('consulta que falha, que devolve lixo ou que não existe nunca lança nem inventa telefone', async () => {
  const livro = new HistoryPhoneBook();
  assert.equal(await livro.phoneFor(LID, () => Promise.reject(new Error('fora do ar'))), null);
  assert.equal(await livro.phoneFor(LID, () => { throw new Error('quebrou'); }), null);
  assert.equal(await livro.phoneFor(LID, () => '990000000000009@lid'), null, 'outro identificador não é telefone');
  assert.equal(await livro.phoneFor(LID, () => 42 as never), null);
  assert.equal(await livro.phoneFor(LID, () => undefined), null);
  assert.equal(await livro.phoneFor(LID, undefined), null, 'sem conexão ativa não há o que consultar');
  assert.equal(await livro.phoneFor(PHONE, () => PHONE), null, 'só resolve conversa endereçada pelo identificador novo');
  assert.equal(await livro.phoneFor(null), null);
  assert.equal(livro.size, 0);
});

test('o livro de pares tem teto: não cresce sem limite', () => {
  const livro = new HistoryPhoneBook();
  const lote = (inicio: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `99${String(inicio + i).padStart(13, '0')}@lid`, phoneNumber: `55${String(inicio + i).padStart(11, '0')}@s.whatsapp.net` }));
  livro.remember(lote(0, 30_000));
  assert.equal(livro.size, 30_000);
  livro.remember(lote(30_000, 30_000));
  assert.ok(livro.size <= 50_000, 'passou do teto');
  assert.equal(livro.size, 30_000, 'ao estourar, fica só com o pacote mais novo');
});

test('o arquivo não escreve em log, banco, cache nem arquivo', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/utils/historyPhoneByLid.ts', import.meta.url), 'utf8');
  const codigo = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.equal(/logger\.|console\.|process\.std|prisma|writeFile|appendFile|fs\.|nodecache|redis|\.hSet\(/i.test(codigo), false);
});
