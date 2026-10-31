// Nenhuma chave de criptografia das sessões do WhatsApp vai para o log.
//
// A biblioteca de criptografia usada por baixo (libsignal) imprime a sessão inteira no console
// quando abre ou fecha uma sessão ("Closing session:", "Opening session:" ...). A sessão traz
// chaves privadas. Este filtro troca qualquer objeto com formato de sessão ou de credencial, e
// qualquer sequência de bytes, por um aviso curto, antes de a linha sair. O texto da linha fica.
//
// Regra deste arquivo: só troca; não lê para guardar, não envia e não escreve nada.

const SECRET_FIELDS = new Set([
  // sessão (libsignal SessionEntry)
  'currentRatchet',
  'indexInfo',
  '_chains',
  'pendingPreKey',
  'ephemeralKeyPair',
  'rootKey',
  'chainKey',
  'messageKeys',
  'baseKey',
  'privKey',
  'privateKey',
  // credenciais do aparelho (Baileys AuthenticationCreds)
  'noiseKey',
  'signedIdentityKey',
  'signedPreKey',
  'pairingEphemeralKeyPair',
  'advSecretKey',
  'identityKey',
]);

const OMITTED = '[omitido: dado de sessão]';
const MAX_DEPTH = 3;
const MAX_KEYS = 64;

function isBytes(value: unknown): boolean {
  return Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function looksSecret(value: unknown, depth: number): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (isBytes(value)) return true;
  if (value instanceof Error) return false;
  if (depth >= MAX_DEPTH) return false;

  let seen = 0;
  for (const key of Object.keys(value as object)) {
    if (++seen > MAX_KEYS) break;
    if (SECRET_FIELDS.has(key)) return true;
    if (looksSecret((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/** Devolve o mesmo argumento quando é seguro; troca por um aviso quando parece sessão ou bytes. */
export function redactArg(value: unknown): unknown {
  return looksSecret(value, 0) ? OMITTED : value;
}

export function redactArgs(args: unknown[]): unknown[] {
  let changed = false;
  const out = args.map((a) => {
    const r = redactArg(a);
    if (r !== a) changed = true;
    return r;
  });
  return changed ? out : args;
}

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const INSTALLED = Symbol.for('evolution.consoleGuard');

export function installConsoleGuard(target: Console = console): void {
  if ((target as any)[INSTALLED]) return;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...redactArgs(args));
  }
  (target as any)[INSTALLED] = true;
}

installConsoleGuard();
