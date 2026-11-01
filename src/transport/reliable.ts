/**
 * Reliable transport: the policy layer between the bridge and the raw Feishu
 * API.
 *
 * Responsibilities (design doc §6 L3 + §12 risk 6):
 * - every outbound message carries a `uuid`, so a retry (or the fallback path)
 *   is idempotent for one hour on Feishu;
 * - a thread reply (`reply_in_thread`) that fails with 230071 / 230072 / 230019
 *   degrades to a normal chat_id send with the SAME uuid — one logical message
 *   must never be delivered twice because the thread is unsupported;
 * - interactive cards are rejected unless `config.update_multi = true`.
 *
 * @module dsh-caduceus/transport/reliable
 */
import { randomUUID } from 'node:crypto';

import { silentLogger, type LoggerLike } from '../logger.js';
import type { FeishuApi } from './feishu-api.js';
import {
  FeishuApiError,
  assertUpdateMulti,
  cardPayload,
  isThreadReplyFallbackCode,
  textPayload,
} from './types.js';
import type {
  CardAction,
  FeishuCard,
  InboundMessage,
  ReplyOptions,
  ReplyPayload,
  SendOptions,
  SentMessage,
  Transport,
} from './types.js';

export interface ReliableTransportOptions {
  readonly logger?: LoggerLike;
  /** Idempotency-key factory (injectable for deterministic tests). */
  readonly uuidFactory?: () => string;
}

/** {@link Transport} over a raw {@link FeishuApi}, adding uuid + fallback policy. */
export class ReliableTransport implements Transport {
  private readonly api: FeishuApi;
  private readonly logger: LoggerLike;
  private readonly uuidFactory: () => string;
  #lastSuccessAt: number | undefined;
  #lastKind: string | undefined;
  #failures = 0;

  constructor(api: FeishuApi, options: ReliableTransportOptions = {}) {
    this.api = api;
    this.logger = options.logger ?? silentLogger();
    this.uuidFactory = options.uuidFactory ?? randomUUID;
  }

  start(): Promise<void> {
    return this.api.start();
  }

  stop(): Promise<void> {
    return this.api.stop();
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.api.onMessage(handler);
  }

  onCardAction(handler: (action: CardAction) => void): void {
    this.api.onCardAction?.(handler);
  }

  /** Forward the bot open id when the underlying API resolved one. */
  getBotOpenId(): string | undefined {
    return this.api.getBotOpenId?.();
  }

  getBotName(): string | undefined {
    return this.api.getBotName?.();
  }

  getConnectionStatus(): { readonly ready: boolean; readonly since?: number } {
    return this.api.getConnectionStatus?.() ?? { ready: false };
  }

  getDeliveryStats(): {
    readonly lastSuccessAt?: number;
    readonly lastKind?: string;
    readonly failures: number;
  } {
    return {
      ...(this.#lastSuccessAt === undefined ? {} : { lastSuccessAt: this.#lastSuccessAt }),
      ...(this.#lastKind === undefined ? {} : { lastKind: this.#lastKind }),
      failures: this.#failures,
    };
  }

  async #record<T>(kind: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      this.#lastSuccessAt = Date.now();
      this.#lastKind = kind;
      return result;
    } catch (error) {
      this.#failures += 1;
      throw error;
    }
  }

  async #recordVoid(kind: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.#lastSuccessAt = Date.now();
      this.#lastKind = kind;
    } catch (error) {
      this.#failures += 1;
      throw error;
    }
  }

  async sendText(chatId: string, text: string, options: SendOptions = {}): Promise<SentMessage> {
    return this.#record('消息', () =>
      this.api.createMessage({
        chatId,
        msgType: 'text',
        content: textPayload(text),
        uuid: options.uuid ?? this.uuidFactory(),
      }),
    );
  }

  async sendCard(chatId: string, card: FeishuCard, options: SendOptions = {}): Promise<SentMessage> {
    assertUpdateMulti(card);
    return this.#record('卡片', () =>
      this.api.createMessage({
        chatId,
        msgType: 'interactive',
        content: cardPayload(card),
        uuid: options.uuid ?? this.uuidFactory(),
      }),
    );
  }

  addReaction(messageId: string, emojiType: string): Promise<string> {
    return this.api.addReaction(messageId, emojiType);
  }

  removeReaction(messageId: string, reactionId: string): Promise<void> {
    return this.api.removeReaction(messageId, reactionId);
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    assertUpdateMulti(card);
    await this.#recordVoid('卡片', () => this.api.patchCard(messageId, card));
  }

  async reply(
    chatId: string,
    messageId: string,
    payload: ReplyPayload,
    options: ReplyOptions = {},
  ): Promise<SentMessage> {
    const uuid = options.uuid ?? this.uuidFactory();
    const msgType = payload.kind === 'text' ? 'text' : 'interactive';
    const content = payload.kind === 'text' ? textPayload(payload.text) : cardPayload(payload.card);
    const replyInThread = options.threadId !== undefined && options.threadId.length > 0;
    const kind = payload.kind === 'card' ? '卡片' : '消息';
    try {
      return await this.#record(kind, () =>
        this.api.replyMessage({ messageId, msgType, content, replyInThread, uuid }),
      );
    } catch (error) {
      if (error instanceof FeishuApiError && isThreadReplyFallbackCode(error.code)) {
        this.logger.warn(
          `thread reply failed with ${error.code}; degrading to chat_id send (uuid ${uuid})`,
        );
        return this.api.createMessage({ chatId, msgType, content, uuid });
      }
      throw error;
    }
  }
}
