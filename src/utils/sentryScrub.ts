// [WA-37] O que o monitor de erros (Sentry) NÃO pode levar para fora.
//
// O monitor, quando ligado, anexa a cada evento a requisição que estava em curso — corpo e
// cabeçalhos inclusive. O corpo de uma requisição a este serviço carrega número, texto de
// mensagem ou mídia; o cabeçalho carrega a chave de acesso. Nada disso sai: o evento segue com o
// método, o caminho e o erro, e sem corpo, sem consulta, sem cookies e sem cabeçalho de acesso.
//
// Regra deste arquivo: só apaga; não lê, não guarda e não escreve nada.

const SECRET_HEADERS = new Set(['apikey', 'authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);

type WithRequest = {
  request?: {
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
    headers?: Record<string, unknown>;
  };
};

export function scrubRequest<T extends WithRequest>(event: T): T {
  const request = event?.request;
  if (!request || typeof request !== 'object') return event;

  delete request.data;
  delete request.cookies;
  delete request.query_string;

  if (request.headers && typeof request.headers === 'object') {
    for (const name of Object.keys(request.headers)) {
      if (SECRET_HEADERS.has(name.toLowerCase())) delete request.headers[name];
    }
  }
  return event;
}
