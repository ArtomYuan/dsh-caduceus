/**
 * Durable record of the pinned per-scope status card.
 *
 * Feishu pins survive process restarts, but the new process must know which
 * message id to unpin when it creates a fresh status card. The record lives at
 * `<DSH_HOME>/caduceus/pins.json` (atomic writes, mode 0600), keyed by the
 * caduceus scope key.
 *
 * @module @artomyuan/dsh-caduceus/pin-store
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomicSync } from './atomic-write.js';
import { dshHome, type HomeEnv } from './home.js';

export interface PinnedStatusCard {
  readonly messageId: string;
  readonly chatId: string;
}

interface PinsDocument {
  readonly version: 1;
  readonly pins: Record<string, PinnedStatusCard>;
}

export interface PinStoreOptions {
  /** Explicit file path (tests); defaults to `<DSH_HOME>/caduceus/pins.json`. */
  readonly filePath?: string;
  readonly env?: HomeEnv;
}

function isPinned(value: unknown): value is PinnedStatusCard {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['messageId'] === 'string' &&
    record['messageId'].length > 0 &&
    typeof record['chatId'] === 'string' &&
    record['chatId'].length > 0
  );
}

/** Persistent scopeKey → pinned status-card message id map. */
export class PinStore {
  readonly #filePath: string;
  readonly #pins = new Map<string, PinnedStatusCard>();
  #loaded = false;

  constructor(options: PinStoreOptions = {}) {
    this.#filePath =
      options.filePath ?? join(dshHome(options.env), 'caduceus', 'pins.json');
  }

  /** Load once; a missing/corrupt file starts empty (never throws). */
  load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.#filePath, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return;
      const pins = (parsed as Record<string, unknown>)['pins'];
      if (typeof pins !== 'object' || pins === null) return;
      for (const [scopeKey, value] of Object.entries(pins)) {
        if (isPinned(value)) this.#pins.set(scopeKey, { messageId: value.messageId, chatId: value.chatId });
      }
    } catch {
      // Missing or unreadable: start empty.
    }
  }

  get(scopeKey: string): PinnedStatusCard | undefined {
    this.load();
    return this.#pins.get(scopeKey);
  }

  set(scopeKey: string, value: PinnedStatusCard): void {
    this.load();
    const current = this.#pins.get(scopeKey);
    if (current?.messageId === value.messageId && current.chatId === value.chatId) return;
    this.#pins.set(scopeKey, value);
    this.#persist();
  }

  delete(scopeKey: string): void {
    this.load();
    if (this.#pins.delete(scopeKey)) this.#persist();
  }

  #persist(): void {
    const pins: Record<string, PinnedStatusCard> = {};
    for (const [scopeKey, value] of this.#pins) pins[scopeKey] = value;
    const document: PinsDocument = { version: 1, pins };
    writeFileAtomicSync(this.#filePath, `${JSON.stringify(document, null, 2)}\n`);
  }
}
