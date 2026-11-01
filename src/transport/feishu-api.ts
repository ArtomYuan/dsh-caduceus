/**
 * Low-level Feishu API seam.
 *
 * The reliable transport (fallback + uuid idempotency) and the bridge are
 * tested against this interface with fakes; the production implementation
 * ({@link LarkFeishuApi}) is the only module that imports the network SDK.
 *
 * @module @artomyuan/dsh-caduceus/transport/feishu-api
 */
import type { FeishuCard, InboundMessage } from './types.js';

export interface CreateMessageInput {
  readonly chatId: string;
  readonly msgType: 'text' | 'interactive';
  /** Serialized `msg_type` content (JSON string). */
  readonly content: string;
  readonly uuid?: string;
}

export interface ReplyMessageInput {
  readonly messageId: string;
  readonly msgType: 'text' | 'interactive';
  readonly content: string;
  /** Post the reply inside the message's topic (`reply_in_thread`). */
  readonly replyInThread: boolean;
  readonly uuid?: string;
}

/** Raw Feishu API operations; business errors are thrown as `FeishuApiError`. */
export interface FeishuApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (message: InboundMessage) => void): void;
  createMessage(input: CreateMessageInput): Promise<{ messageId: string }>;
  replyMessage(input: ReplyMessageInput): Promise<{ messageId: string }>;
  patchCard(messageId: string, card: FeishuCard): Promise<void>;
  /** The bot's own open id, when resolved (group @ gate). */
  getBotOpenId?(): string | undefined;
  /** Cached bot display name, resolved once at startup. */
  getBotName?(): string | undefined;
  /** Long-connection status and start time, when known. */
  getConnectionStatus?(): { readonly ready: boolean; readonly since?: number };
}
