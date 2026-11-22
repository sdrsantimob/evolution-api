// [WA-70] Declaração de histórico do aparelho vinculado + pedido com o identificador da conta.
// Dado 100% sintético. Rodar: npx tsx --test tests/historySyncCapabilities.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proto } from 'baileys';

import { buildOnDemandRequest } from '../src/utils/groupHistoryRequest';
import { applyHistorySyncCapabilities, HISTORY_SYNC_CAPABILITIES } from '../src/utils/historySyncCapabilities';

const companion = () => ({
  os: 'Sintetico',
  platformType: proto.DeviceProps.PlatformType.CHROME,
  requireFullSync: true,
  historySyncConfig: { storageQuotaMb: 10240, supportGroupHistory: false, supportCallLogHistory: false },
});

test('no pareamento, a declaração passa a dizer: recebe histórico de grupo e sob demanda', () => {
  assert.equal(applyHistorySyncCapabilities(proto as never), true);
  const bytes = proto.DeviceProps.encode(companion()).finish();
  const lido = proto.DeviceProps.decode(bytes);
  assert.equal(lido.historySyncConfig?.supportGroupHistory, true);
  assert.equal(lido.historySyncConfig?.onDemandReady, true);
  // o resto da declaração continua igual
  assert.equal(lido.historySyncConfig?.storageQuotaMb, 10240);
  assert.equal(lido.historySyncConfig?.supportCallLogHistory, false);
  assert.equal(lido.os, 'Sintetico');
  assert.equal(lido.requireFullSync, true);
});

test('só os dois campos mudam e o objeto de quem chamou não é alterado', () => {
  assert.deepEqual(Object.keys(HISTORY_SYNC_CAPABILITIES).sort(), ['onDemandReady', 'supportGroupHistory']);
  const original = companion();
  proto.DeviceProps.encode(original).finish();
  assert.equal(original.historySyncConfig.supportGroupHistory, false);
});

test('aplicar duas vezes não embrulha duas vezes', () => {
  const encode = proto.DeviceProps.encode;
  assert.equal(applyHistorySyncCapabilities(proto as never), true);
  assert.equal(proto.DeviceProps.encode, encode);
});

test('o pedido leva a âncora e o identificador da conta sem o número do aparelho', () => {
  const anchor = { key: { remoteJid: '120363000000000001@g.us', id: '3EB0AAAAAAAAAAAAAAAA', fromMe: false }, timestampMs: 1763800000000, count: 50 };
  assert.deepEqual(buildOnDemandRequest(anchor, '990000000000001:12@lid'), {
    chatJid: anchor.key.remoteJid, oldestMsgId: anchor.key.id, oldestMsgFromMe: false,
    oldestMsgTimestampMs: anchor.timestampMs, onDemandMsgCount: 50, accountLid: '990000000000001@lid',
  });
  // sem identificador da conta (ou fora do formato), o pedido sai sem o campo — nunca com lixo
  for (const lid of [undefined, null, '', '5500000000001@s.whatsapp.net', 'qualquer']) {
    assert.equal('accountLid' in buildOnDemandRequest(anchor, lid), false, String(lid));
  }
  // e cabe no formato do WhatsApp
  const msg = proto.Message.PeerDataOperationRequestMessage.fromObject({
    historySyncOnDemandRequest: buildOnDemandRequest(anchor, '990000000000001@lid'),
    peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
  });
  assert.equal(msg.historySyncOnDemandRequest?.accountLid, '990000000000001@lid');
  assert.equal(msg.historySyncOnDemandRequest?.chatJid, anchor.key.remoteJid);
});
