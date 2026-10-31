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

export interface CardStreamOptions {
  readonly throttleMs: number;
  readonly clock?: Clock;
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
    if (elapsed >= this.#throttleMs) {
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
    const elapsed = this.#clock.now() - this.#lastSentAt;
    const delay = Math.max(0, this.#throttleMs - elapsed);
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
