/**
 * Throttled card stream: one live card per logical stream, patched at most once
 * per `throttleMs`, only when the rendered content actually changed.
 *
 * The default 400 ms matches the production dsh-feishu value (half of Feishu's
 * 5 QPS card-patch budget, design doc §6 L3). The clock is injectable so unit
 * tests advance time deterministically instead of sleeping.
 *
 * @module @artomyuan/dsh-caduceus/render/stream
 */
import type { SentMessage, FeishuCard } from '../transport/types.js';

/** Opaque timer handle; the system clock returns a Node timer, fakes return ids. */
export type TimerHandle = unknown;

/** Injectable time source. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** The real time source. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Where a card stream creates and patches its one message. */
export interface CardChannel {
  create(card: FeishuCard): Promise<SentMessage>;
  update(messageId: string, card: FeishuCard): Promise<void>;
}

/**
 * One throttle window shared by SEVERAL card streams (e.g. a per-turn process
 * card and a per-scope status card), so rendering both cannot double the patch
 * rate. Initial creates are not gated (each card needs its first message);
 * patches consume the window.
 */
export class CardPatchBudget {
  #lastAt: number | undefined;

  /** Consume the current window if it is free; returns whether it was taken. */
  tryConsume(now: number, windowMs: number): boolean {
    if (this.#lastAt !== undefined && now - this.#lastAt < windowMs) return false;
    this.#lastAt = now;
    return true;
  }

  /** Milliseconds until the shared window opens (0 when already open). */
  remaining(now: number, windowMs: number): number {
    if (this.#lastAt === undefined) return 0;
    return Math.max(0, windowMs - (now - this.#lastAt));
  }

  /** Record a patch send (also used by flushes that bypass `tryConsume`). */
  mark(now: number): void {
    this.#lastAt = now;
  }
}

export interface CardStreamOptions {
  readonly throttleMs: number;
  readonly clock?: Clock;
  /** Shared patch window across sibling streams (process + status cards). */
  readonly budget?: CardPatchBudget;
  /** When provided, send failures are reported here instead of rejecting. */
  readonly onError?: (error: unknown) => void;
}

/**
 * A single live card with leading + trailing throttling:
 * - the first `set` creates the message immediately (no silent turn);
 * - later `set` calls inside the window coalesce into the last content and
 *   flush once the window elapses;
 * - identical content is never sent twice.
 */
export class CardStream {
  readonly #channel: CardChannel;
  readonly #clock: Clock;
  readonly #throttleMs: number;
  readonly #budget: CardPatchBudget | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;

  #messageId: string | undefined;
  #lastSentJson: string | undefined;
  #pendingCard: FeishuCard | undefined;
  #pendingJson: string | undefined;
  #timer: TimerHandle | undefined;
  #lastSentAt = 0;
  #chain: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(channel: CardChannel, options: CardStreamOptions) {
    this.#channel = channel;
    this.#clock = options.clock ?? systemClock;
    this.#throttleMs = Math.max(1, options.throttleMs);
    this.#budget = options.budget;
    this.#onError = options.onError;
  }

  /** The created message id, or `undefined` before the first `set`. */
  get messageId(): string | undefined {
    return this.#messageId;
  }

  /** Queue the latest card state; resolves after the send/patch attempt. */
  async set(card: FeishuCard): Promise<void> {
    if (this.#disposed) return;
    const json = JSON.stringify(card);
    if (json === this.#lastSentJson || json === this.#pendingJson) return;

    if (this.#messageId === undefined) {
      this.#clearPending();
      await this.#enqueue(card, json);
      return;
    }

    const elapsed = this.#clock.now() - this.#lastSentAt;
    const free = elapsed >= this.#throttleMs &&
      (this.#budget === undefined || this.#budget.tryConsume(this.#clock.now(), this.#throttleMs));
    if (free) {
      this.#clearPending();
      await this.#enqueue(card, json);
      return;
    }
    this.#pendingCard = card;
    this.#pendingJson = json;
    this.#arm();
  }

  /** Send the newest pending state immediately (used at turn end). */
  async flush(): Promise<void> {
    if (this.#disposed) return;
    const card = this.#pendingCard;
    const json = this.#pendingJson;
    if (card === undefined || json === undefined) return;
    this.#clearPending();
    await this.#enqueue(card, json);
  }

  /** Stop the stream and drop any pending update. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearPending();
  }

  #clearPending(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#pendingCard = undefined;
    this.#pendingJson = undefined;
  }

  #arm(): void {
    if (this.#timer !== undefined) return;
    const now = this.#clock.now();
    const elapsed = now - this.#lastSentAt;
    const delay = Math.max(
      Math.max(0, this.#throttleMs - elapsed),
      this.#budget?.remaining(now, this.#throttleMs) ?? 0,
    );
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      void this.flush().catch((error: unknown) => this.#report(error));
    }, delay);
  }

  #enqueue(card: FeishuCard, json: string): Promise<void> {
    const run = this.#chain.then(async () => {
      if (this.#disposed) return;
      if (this.#messageId === undefined) {
        const sent = await this.#channel.create(card);
        this.#messageId = sent.messageId;
      } else {
        await this.#channel.update(this.#messageId, card);
        this.#budget?.mark(this.#clock.now());
      }
      this.#lastSentJson = json;
      this.#lastSentAt = this.#clock.now();
    });
    this.#chain = run.then(
      () => undefined,
      (error: unknown) => this.#report(error),
    );
    return run.catch((error: unknown) => {
      if (this.#onError === undefined) throw error;
    });
  }

  #report(error: unknown): void {
    this.#onError?.(error);
  }
}
