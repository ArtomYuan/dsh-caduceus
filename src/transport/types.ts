/**
 * Transport seam types: normalized inbound message, Feishu card payloads, and
 * the interface every transport implementation (the real long connection and
 * the test fakes) satisfies.
 *
 * Feishu limits that shape this contract (design doc §12 risk 2):
 * - an interactive card patch has no rate limit but must declare
 *   `config.update_multi = true`, lives ≤14 days, and stays ≤30 KB;
 * - thread replies use `reply_in_thread` and can fail with 230071 / 230072 /
 *   230019, which the reliable transport degrades to a plain chat_id send;
 * - `uuid` makes retries idempotent for one hour on the platform side.
 *
 * @module @artomyuan/dsh-caduceus/transport/types
 */

/** Feishu chat kind. */
export type ChatType = 'p2p' | 'group';

/** Result code of an unsuccessful Feishu API call. */
export class FeishuApiError extends Error {
  readonly code: number;

  constructor(message: string, code: number) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = code;
  }
}

/** Failure codes that mean "thread replies are not supported here". */
export const THREAD_REPLY_FALLBACK_CODES: readonly number[] = [230071, 230072, 230019];

/** True when a thread reply failure must degrade to a chat_id send. */
export function isThreadReplyFallbackCode(code: number): boolean {
  return THREAD_REPLY_FALLBACK_CODES.includes(code);
}

/** One inbound Feishu message, normalized for the bridge. */
export interface InboundMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: ChatType;
  readonly senderOpenId: string;
  /**
   * Open ids mentioned in the message (the bot's own open id included when it
   * is mentioned). Empty/absent when there is no mention. The bridge's group
   * @ gate reads this.
   */
  readonly mentions?: readonly string[];
  readonly text: string;
  /**
   * Topic/thread id, normalized as `thread_id ?? root_id`. Present when the
   * message lives inside a Feishu topic; outbound replies reuse it so the
   * bot's answer lands in the same topic (design doc A6).
   */
  readonly threadId?: string;
  /** Raw Feishu `root_id`, kept for diagnostics even when `thread_id` wins. */
  readonly rootId?: string;
  /** Unix epoch milliseconds from Feishu; `0` when the event omitted it. */
  readonly createdAt: number;
}

/** A created message. */
export interface SentMessage {
  readonly messageId: string;
}

/** Feishu v1 card text run. */
export interface FeishuCardText {
  readonly tag: 'plain_text' | 'lark_md';
  readonly content: string;
}

/** One element of a Feishu v1 interactive card. */
export interface FeishuCardElement {
  readonly tag: string;
  readonly text?: FeishuCardText;
  readonly fields?: readonly {
    readonly is_short?: boolean;
    readonly text?: FeishuCardText;
  }[];
  readonly [key: string]: unknown;
}

/** Feishu interactive card JSON (v1 layout; no `schema` field). */
export interface FeishuCard {
  readonly config: {
    /** Required for in-place patch updates. */
    readonly update_multi: true;
    readonly wide_screen_mode?: boolean;
  };
  readonly header?: {
    readonly title: {
      readonly tag: 'plain_text';
      readonly content: string;
    };
    readonly template?: string;
  };
  readonly elements: readonly FeishuCardElement[];
}

/** The payload of an outbound reply. */
export type ReplyPayload =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'card'; readonly card: FeishuCard };

export interface SendOptions {
  /** Idempotency key; the same key may succeed only once per hour on Feishu. */
  readonly uuid?: string;
}

export interface ReplyOptions extends SendOptions {
  /** When set, the reply is posted inside this Feishu topic. */
  readonly threadId?: string;
}

/**
 * The transport contract. Every outbound path is a new message (`reply`,
 * `sendText`, `sendCard`) or an in-place card patch (`updateCard`); the bridge
 * never edits the final answer into the progress card.
 */
export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: InboundMessage) => void): void;
  sendText(chatId: string, text: string, options?: SendOptions): Promise<SentMessage>;
  sendCard(chatId: string, card: FeishuCard, options?: SendOptions): Promise<SentMessage>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
  /**
   * The bot's own open id when known (needed for the group @ gate). Optional:
   * fake transports may omit it, and the real one resolves it lazily.
   */
  getBotOpenId?(): string | undefined;
  /** Reply to an existing message; `threadId` enables `reply_in_thread`. */
  reply(
    chatId: string,
    messageId: string,
    payload: ReplyPayload,
    options?: ReplyOptions,
  ): Promise<SentMessage>;
}

/** Validate the mandatory `update_multi` flag before any card leaves the process. */
export function assertUpdateMulti(card: FeishuCard): void {
  if (card.config?.update_multi !== true) {
    throw new TypeError('feishu card must declare config.update_multi = true for in-place patches');
  }
}

/** JSON text payload for `msg_type: text`. */
export function textPayload(text: string): string {
  return JSON.stringify({ text });
}

/** JSON payload for `msg_type: interactive`. */
export function cardPayload(card: FeishuCard): string {
  assertUpdateMulti(card);
  return JSON.stringify(card);
}

/** Byte size of a card's serialized form (Feishu caps a card at 30 KB). */
export function cardBytes(card: FeishuCard): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}
