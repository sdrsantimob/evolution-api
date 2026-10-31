// Memória curta do que o conector já leu ou gravou no banco, para não repetir a mesma leitura
// ou a mesma gravação a cada evento do WhatsApp. O banco do conector dorme quando fica 5 minutos
// sem consulta; cada leitura repetida o acorda e gasta a cota.
//
// Regras:
// - guarda só o mínimo para comparar (id, nome, endereço da foto), nunca o conteúdo da mensagem;
// - tem tamanho máximo (descarta o mais antigo) e validade (depois dela, volta a ler o banco),
//   então qualquer divergência se corrige sozinha;
// - quem grava o mesmo registro por outro caminho chama `delete` para a próxima leitura ir ao banco.

export class RecordMemo<V> {
  private readonly map = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly maxEntries = 5000,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** `undefined` = não sabe (ir ao banco). Qualquer outro valor, inclusive `null`, é resposta guardada. */
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key: string | null | undefined): void {
    if (key) this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Endereço da foto sem a parte que muda a cada consulta (assinatura e validade do link). */
export function samePicture(a?: string | null, b?: string | null): boolean {
  const base = (u?: string | null) => (u ? u.split('?')[0] : '');
  return base(a) === base(b);
}
