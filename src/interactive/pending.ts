/**
 * In-memory pending interactive requests (one per approval/question card).
 *
 * Entries are keyed by a random id embedded in every button value. They carry
 * the scope owner so a click from anyone else can be ignored. The registry is
 * intentionally dumb: the runtime decides when an entry settles, patches the
 * card, and clears timers through `cleanup`.
 *
 * @module dsh-caduceus/interactive/pending
 */
import { randomUUID } from 'node:crypto';

export type PendingKind = 'approval' | 'question';

export interface PendingEntry {
  readonly id: string;
  readonly kind: PendingKind;
  readonly scopeKey: string;
  readonly chatId: string;
  readonly ownerOpenId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  /** Card message id assigned after a successful send. */
  cardMessageId?: string;
  /** Extra presentation data (tool name / questions). */
  readonly meta?: Record<string, unknown>;
  /** Clears timers/signal listeners when the runtime settles the entry. */
  cleanup?: () => void;
}

export type NewPendingEntry = Omit<PendingEntry, 'id'> & { readonly id?: string };

export class PendingRegistry {
  readonly #entries = new Map<string, PendingEntry>();

  add(entry: NewPendingEntry): PendingEntry {
    const id = entry.id ?? randomUUID();
    const value: PendingEntry = { ...entry, id };
    this.#entries.set(id, value);
    return value;
  }

  get(id: string): PendingEntry | undefined {
    return this.#entries.get(id);
  }

  delete(id: string): PendingEntry | undefined {
    const value = this.#entries.get(id);
    if (value === undefined) return undefined;
    this.#entries.delete(id);
    value.cleanup?.();
    return value;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.cleanup?.();
    this.#entries.clear();
  }
}
