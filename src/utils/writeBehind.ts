// Gravações agrupadas de contatos e conversas no banco do conector.
//
// Por quê: com vários números ativos, cada contato novo ou nome trocado acordava o banco do
// conector a qualquer hora do dia. Agrupando, o banco acorda no máximo uma vez a cada intervalo
// (padrão 30 min), ou quando alguém lê a agenda/lista — e aí lê já com tudo gravado.
//
// O que NÃO muda: mensagens e avisos ao painel continuam saindo na hora (este arquivo só trata do
// registro de contatos e conversas no banco do conector). Crachá, configurações, exclusões e
// etiquetas continuam gravando na hora.
//
// Garantias:
// - Durável antes de responder: a gravação pendente vai para o Redis antes de seguir. Reinício ou
//   queda do conector não perde nada: na volta, as pendentes são relidas e gravadas.
// - Redis indisponível: grava direto no banco, como antes (nada fica só na memória sem tentar).
//   Se o banco também falhar, a gravação fica na memória e é tentada de novo no próximo ciclo.
// - Repetível: cada pendente guarda o ESTADO FINAL do registro (não a sequência de passos), e a
//   gravação é um "cria ou atualiza". Gravar duas vezes dá o mesmo resultado.
// - Ordem: por registro vale a última versão (as mudanças se somam na ordem em que chegaram).
//   Conversa: criar vem antes de atualizar. Exclusão cancela a pendente e grava na hora.
// - Sem corrida: a pendente só é apagada se não mudou enquanto era gravada.
// - Leitura vê tudo: quem lê a agenda ou a lista pelo conector força a gravação antes.
// - Desligar (CONECTOR_GRAVACAO_AGRUPADA=false) não perde nada: as pendentes que estiverem no
//   Redis continuam sendo lidas e gravadas.
//
// Regra deste arquivo: guarda só nome, foto e marcadores da conversa — nunca mensagem nem crachá.

export type PendingWrite = {
  kind: 'contact' | 'chat';
  remoteJid: string;
  create?: Record<string, any>;
  update: Record<string, any>;
  v: number;
};

export interface PendingStore {
  save(field: string, value: string): Promise<void>; // erro sobe
  remove(field: string): Promise<void>; // erro sobe
  loadAll(): Promise<Record<string, string>>; // erro sobe
  clear(): Promise<void>;
}

export interface PendingExecutor {
  contact(entry: PendingWrite): Promise<void>;
  chat(entry: PendingWrite): Promise<void>;
}

type Log = { info: (o: any) => void; warn: (o: any) => void };

export const gravacaoAgrupadaLigada = () => process.env.CONECTOR_GRAVACAO_AGRUPADA === 'true';
export const intervaloGravacaoMs = () =>
  Math.max(1, Number(process.env.CONECTOR_GRAVACAO_INTERVALO_MIN || 30)) * 60_000;

const fieldOf = (kind: string, remoteJid: string) => `${kind}:${remoteJid}`;

export function mergePending(old: PendingWrite | undefined, next: PendingWrite): PendingWrite {
  if (!old) return { ...next, update: { ...next.update } };
  let create = old.create ?? next.create;
  if (old.create && next.create) {
    create = { ...old.create, ...next.create };
    if (next.kind === 'chat' && old.create.id) create.id = old.create.id; // a conversa mantém o 1º id
    if (!next.create.pushName && old.create.pushName) create.pushName = old.create.pushName;
  }
  return { kind: next.kind, remoteJid: next.remoteJid, create, update: { ...old.update, ...next.update }, v: next.v };
}

export class WriteBehind {
  private readonly pending = new Map<string, PendingWrite>();
  private version = 0;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly store: PendingStore | null,
    private readonly exec: PendingExecutor,
    private readonly log: Log,
    private readonly opts: { enabled: () => boolean; intervalMs: () => number } = {
      enabled: gravacaoAgrupadaLigada,
      intervalMs: intervaloGravacaoMs,
    },
  ) {}

  get size() {
    return this.pending.size;
  }

  entries(): PendingWrite[] {
    return [...this.pending.values()];
  }

  private run(entry: PendingWrite) {
    return entry.kind === 'contact' ? this.exec.contact(entry) : this.exec.chat(entry);
  }

  /** Registra a gravação. Agrupada quando ligada e o Redis aceitou; senão grava na hora. */
  async enqueue(
    kind: 'contact' | 'chat',
    remoteJid: string,
    create: Record<string, any> | undefined,
    update: Record<string, any>,
  ) {
    const field = fieldOf(kind, remoteJid);
    const merged = mergePending(this.pending.get(field), { kind, remoteJid, create, update, v: ++this.version });
    if (!this.opts.enabled() || !this.store || this.stopped) {
      // Desligado: grava na hora o estado somado (inclui pendentes antigas do mesmo registro).
      await this.run(merged);
      this.forget(field, merged.v);
      return;
    }
    this.pending.set(field, merged);
    try {
      await this.store.save(field, JSON.stringify(merged));
    } catch {
      // Redis fora: não confia só na memória. Grava direto; se o banco também falhar, a pendente
      // fica na memória e o próximo ciclo tenta de novo.
      this.log.warn({ action: 'gravacao.redis-indisponivel', modo: 'direto', field: kind });
      try {
        await this.run(merged);
        this.forget(field, merged.v);
      } catch {
        this.log.warn({ action: 'gravacao.adiada', motivo: 'banco e Redis indisponíveis', field: kind });
      }
    }
    this.arm();
  }

  /** Gravação feita direto por outro caminho: soma na pendente do mesmo registro, se houver. */
  async patchIfPending(kind: 'contact' | 'chat', remoteJid: string, update: Record<string, any>) {
    const field = fieldOf(kind, remoteJid);
    const cur = this.pending.get(field);
    if (!cur) return;
    const merged = {
      ...cur,
      update: { ...cur.update, ...update },
      create: cur.create ? { ...cur.create, ...update } : cur.create,
      v: ++this.version,
    };
    this.pending.set(field, merged);
    if (this.store) await this.store.save(field, JSON.stringify(merged)).catch(() => undefined);
  }

  /** Cancela a pendente de um registro que vai ser excluído (a exclusão grava na hora). */
  async cancel(kind: 'contact' | 'chat', remoteJid: string) {
    const field = fieldOf(kind, remoteJid);
    this.pending.delete(field);
    if (this.store) await this.store.remove(field).catch(() => undefined);
  }

  private forget(field: string, v: number) {
    const now = this.pending.get(field);
    if (now && now.v !== v) return; // mudou enquanto gravava: fica para o próximo ciclo
    this.pending.delete(field);
    if (this.store) this.store.remove(field).catch(() => undefined); // emitido já, sem espera antes
  }

  /** Relê as pendentes guardadas (reinício, queda) e grava. Roda com o agrupamento ligado ou não. */
  async recover() {
    if (!this.store) return;
    let saved: Record<string, string>;
    try {
      saved = await this.store.loadAll();
    } catch {
      this.log.warn({ action: 'gravacao.recuperacao.adiada', motivo: 'Redis indisponível' });
      return;
    }
    for (const [field, raw] of Object.entries(saved)) {
      try {
        const entry = JSON.parse(raw) as PendingWrite;
        const mem = this.pending.get(field);
        // O que está na memória é mais novo (chegou depois da partida): soma por cima do guardado.
        this.pending.set(field, mem ? mergePending({ ...entry, v: 0 }, mem) : { ...entry, v: ++this.version });
      } catch {
        this.log.warn({ action: 'gravacao.recuperacao.ilegivel', field: field.split(':')[0] });
      }
    }
    if (this.pending.size) this.log.info({ action: 'gravacao.recuperada', pendentes: this.pending.size });
    await this.flush('recuperacao');
  }

  /** Grava todas as pendentes. Chamadas simultâneas esperam a mesma rodada. */
  flush(reason = 'ciclo'): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.pending.size) return Promise.resolve();
    this.flushing = (async () => {
      const snapshot = [...this.pending.entries()];
      // Conversas antes de contatos não importa; dentro de cada conversa, criar vem antes de atualizar
      // (feito no executor). Uma falha não interrompe as outras.
      let failed = 0;
      for (const [field, entry] of snapshot) {
        try {
          await this.run(entry);
          this.forget(field, entry.v);
        } catch {
          failed++;
        }
      }
      if (failed) {
        this.failures++;
        this.log.warn({ action: 'gravacao.falhou', pendentes: failed, motivo: reason });
      } else {
        this.failures = 0;
      }
    })().finally(() => {
      this.flushing = null;
      this.arm();
    });
    return this.flushing;
  }

  private arm() {
    if (this.timer || this.stopped || !this.pending.size) return;
    // Falhas seguidas (banco fora): espera cresce até 4x o intervalo.
    // Espera acima do limite do relógio do Node (~24,8 dias) dispararia na hora: limita.
    const wait = Math.min(2_147_000_000, this.opts.intervalMs() * Math.min(4, 1 + this.failures));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush('ciclo').catch(() => undefined);
    }, wait);
    this.timer.unref?.();
  }

  /** Número excluído: as pendentes dele não valem mais. */
  async discard() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    if (this.store) await this.store.clear().catch(() => undefined);
  }
}
