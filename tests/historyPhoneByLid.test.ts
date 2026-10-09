// [WA-34] Telefone anexado às mensagens do histórico.
// Dado 100% sintético. Rodar: npx tsx --test tests/historyPhoneByLid.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attachPhone,
  buildPhoneByLid,
  countChatAddresses,
  HistoryPhoneBook,
  lidBeforeSwap,
  needsPhone,
  newHistoryStats,
  withBothAddresses,
} from '../src/utils/historyPhoneByLid';

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

// ─── Mensagem ao vivo: os dois endereços no aviso ─────────────────────────────

test('ao vivo: o aviso leva telefone e identificador, sem mexer na mensagem que o conector segue usando', () => {
  // como a mensagem chega da biblioteca: identificador no endereço, telefone no alternativo
  const messageRaw = { key: { remoteJid: LID, remoteJidAlt: PHONE, id: 'm1', fromMe: false, addressingMode: 'lid' }, pushName: 'TESTE_' };
  const lid = lidBeforeSwap(messageRaw.key);
  assert.equal(lid, LID);

  // o conector troca o endereço pelo telefone (comportamento que já existia)
  messageRaw.key.remoteJid = messageRaw.key.remoteJidAlt;

  const aviso = withBothAddresses(messageRaw, lid);
  assert.deepEqual(aviso.key, { remoteJid: PHONE, remoteJidAlt: LID, id: 'm1', fromMe: false, addressingMode: 'lid' });
  assert.equal(aviso.pushName, 'TESTE_');
  // a mensagem original não muda: o que vem depois (cache, integrações) continua igual
  assert.notEqual(aviso, messageRaw);
  assert.deepEqual(messageRaw.key, { remoteJid: PHONE, remoteJidAlt: PHONE, id: 'm1', fromMe: false, addressingMode: 'lid' });
});

test('ao vivo: sem identificador, ou sem telefone no endereço, o aviso sai como sempre saiu', () => {
  const porTelefone = { key: { remoteJid: PHONE, id: 'm2' } };
  assert.equal(lidBeforeSwap(porTelefone.key), null);
  assert.equal(withBothAddresses(porTelefone, null), porTelefone);

  const grupo = { key: { remoteJid: '120363000000000001@g.us', participant: LID, id: 'm3' } };
  assert.equal(lidBeforeSwap(grupo.key), null);
  assert.equal(withBothAddresses(grupo, LID), grupo, 'grupo não é tocado');

  const soIdentificador = { key: { remoteJid: LID, id: 'm4' } }; // a biblioteca não informou o telefone
  assert.equal(lidBeforeSwap(soIdentificador.key), null);
  assert.equal(withBothAddresses(soIdentificador, LID), soIdentificador);

  assert.equal(lidBeforeSwap(undefined), null);
  assert.equal(lidBeforeSwap({ remoteJid: LID, remoteJidAlt: '990000000000002@lid' }), null, 'alternativo que não é telefone');
});

// ─── Contagens ────────────────────────────────────────────────────────────────

test('contagens: só números, e o tipo do pacote vira um contador', () => {
  const inicial = newHistoryStats(0);
  const completo = newHistoryStats(2);
  const recente = newHistoryStats(3);
  const nomes = newHistoryStats(4);
  const outro = newHistoryStats(undefined);
  assert.deepEqual(
    [inicial.packetsBootstrap, completo.packetsFull, recente.packetsRecent, nomes.packetsPushName, outro.packetsOther],
    [1, 1, 1, 1, 1],
  );
  assert.equal(inicial.packetsOther + inicial.packetsFull + inicial.packetsRecent + inicial.packetsPushName, 0);

  countChatAddresses(inicial, [{ id: LID }, { id: PHONE }, { id: '120363000000000001@g.us' }, { id: 5 }, {}] as never);
  assert.deepEqual([inicial.chats, inicial.chatsLid, inicial.chatsPhone], [5, 1, 1]);
  countChatAddresses(inicial, undefined);
  assert.equal(inicial.chats, 5);

  assert.ok(Object.values(inicial).every((v) => typeof v === 'number' && Number.isFinite(v)));
  assert.equal(/@|lid|whatsapp|5500000/.test(JSON.stringify(inicial).replace(/chatsLid|messagesLid/g, '')), false, 'nenhum endereço nas contagens');
});

test('livro de pares: sabe dizer se já conhece o endereço', () => {
  const livro = new HistoryPhoneBook();
  assert.equal(livro.has(LID), false);
  livro.remember([{ id: LID, phoneNumber: PHONE }]);
  assert.equal(livro.has(LID), true);
  assert.equal(livro.has(PHONE), false);
  assert.equal(livro.has(null), false);
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
