// [WA-70] O que este aparelho vinculado diz ao celular que sabe receber de histórico.
//
// Medido em produção em 22/11/2026: o pedido de histórico antigo de um grupo saía e o celular não
// respondia nada (nenhum pacote de histórico chegou). Na biblioteca do WhatsApp (Baileys
// 7.0.0-rc.9, `Utils/validate-connection.js` › `generateRegistrationNode`), o aparelho vinculado
// declara no PAREAMENTO `historySyncConfig.supportGroupHistory: false` e não declara
// `onDemandReady` — ou seja, diz ao celular que não recebe histórico de grupo nem histórico sob
// demanda. A biblioteca não oferece opção para mudar isso; este arquivo acrescenta as duas
// declarações na única hora em que elas são codificadas (`proto.DeviceProps.encode`, chamada só
// no pareamento) e não mexe em mais nada.
//
// Decisão do Samuel no chat em 22/11/2026 (repassada pela aba de origem, com a frase dele): "1,
// pode fazer o ajuste e reconectar".
//
// Limites declarados:
//   • vale para PAREAMENTO NOVO — conexão já pareada só aprende a declaração nova reconectando (QR);
//   • declarar não obriga o celular a responder: se ele ainda não mandar, é limite do WhatsApp;
//   • nada aqui grava, guarda ou escreve em registro; só muda dois campos da declaração.

type DevicePropsLike = {
  encode: (message: unknown, writer?: unknown) => unknown;
  [marker: string]: unknown;
};

// As declarações acrescentadas. Lista fechada: só estes dois campos mudam.
export const HISTORY_SYNC_CAPABILITIES = Object.freeze({ supportGroupHistory: true, onDemandReady: true });

const MARKER = '__wa70HistorySyncCapabilities';

// Recebe o `proto` da biblioteca. Idempotente: chamar duas vezes não embrulha duas vezes.
export function applyHistorySyncCapabilities(proto: { DeviceProps: DevicePropsLike }): boolean {
  const deviceProps = proto?.DeviceProps;
  if (!deviceProps || typeof deviceProps.encode !== 'function') return false;
  if (deviceProps[MARKER] === true) return true;
  const original = deviceProps.encode.bind(deviceProps);
  deviceProps.encode = (message: unknown, writer?: unknown) => {
    if (!message || typeof message !== 'object') return original(message, writer);
    const current = (message as { historySyncConfig?: Record<string, unknown> }).historySyncConfig || {};
    const withCapabilities = {
      ...(message as object),
      historySyncConfig: { ...current, ...HISTORY_SYNC_CAPABILITIES },
    };
    return original(withCapabilities, writer);
  };
  deviceProps[MARKER] = true;
  return true;
}
