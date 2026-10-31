// Memória curta do que o conector já leu ou gravou no banco, para não repetir a mesma leitura
// ou a mesma gravação a cada evento do WhatsApp. O banco do conector dorme quando fica 5 minutos
// sem consulta; cada leitura repetida o acorda e gasta a cota.
//
// Regras:
// - guarda só o mínimo para comparar (id, nome, endereço da foto), nunca o conteúdo da mensagem;
// - tem tamanho máximo (descarta o mais antigo) e validade (depois dela, volta a ler o banco),
//   então qualquer divergência se corrige sozinha;
// - quem grava o mesmo registro por outro caminho chama `delete` para a próxima leitura ir ao banco.

/**
 * Interruptor de reversão: CONECTOR_MEMORIA_CURTA=false desliga a memória curta e a leitura das
 * configurações em memória (o conector volta a consultar o banco a cada evento), SEM desligar as
 * proteções do crachá nem o filtro do log. É o caminho de volta que não reabre risco.
 */
export const memoriaCurtaLigada = () => process.env.CONECTOR_MEMORIA_CURTA !== 'false';

export class RecordMemo<V> {
  private readonly map = new Map<string, { value: V; at: number }>();
  // Lista completa: carregada de uma vez (todas as conversas ou contatos do número). Enquanto vale,
  // "não está na memória" quer dizer "não existe no banco", sem consultar. Chaves alteradas por outro
  // caminho (delete) voltam a ser lidas do banco.
  private completeUntil = 0;
  private readonly mustRead = new Set<string>();

  constructor(
    private readonly maxEntries = 5000,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** `undefined` = não sabe (ir ao banco). Qualquer outro valor, inclusive `null`, é resposta guardada. */
  get(key: string): V | undefined {
    if (!memoriaCurtaLigada()) return undefined;
    if (this.mustRead.has(key)) return undefined;
    const complete = this.isComplete();
    const hit = this.map.get(key);
    if (!hit) return complete ? (null as V) : undefined;
    if (!complete && this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): void {
    this.mustRead.delete(key);
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.completeUntil = 0; // não cabe tudo: deixa de ser lista completa
    }
  }

  delete(key: string | null | undefined): void {
    if (!key) return;
    this.map.delete(key);
    if (this.isComplete()) this.mustRead.add(key);
  }

  /** Carrega a lista completa. Só vale se couber inteira; senão fica como memória comum. */
  loadComplete(entries: Array<[string, V]>, validForMs: number): boolean {
    this.clear();
    if (entries.length >= this.maxEntries) {
      for (const [k, v] of entries.slice(0, this.maxEntries)) this.set(k, v);
      return false;
    }
    for (const [k, v] of entries) this.set(k, v);
    this.completeUntil = this.now() + validForMs;
    return true;
  }

  isComplete(): boolean {
    return this.completeUntil > this.now();
  }

  clear(): void {
    this.map.clear();
    this.mustRead.clear();
    this.completeUntil = 0;
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
