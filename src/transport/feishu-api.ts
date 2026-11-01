/**
 * Low-level Feishu API seam.
 *
 * The reliable transport (fallback + uuid idempotency) and the bridge are
 * tested against this interface with fakes; the production implementation
 * ({@link LarkFeishuApi}) is the only module that imports the network SDK.
 *
 * @module dsh-caduceus/transport/feishu-api
 */
import type { CardAction, FeishuCard, InboundMessage } from './types.js';

export interface CreateMessageInput {
  readonly chatId: string;
  readonly msgType: 'text' | 'interactive' | 'file' | 'image';
  /** Serialized `msg_type` content (JSON string). */
  readonly content: string;
  readonly uuid?: string;
}

export interface ReplyMessageInput {
  readonly messageId: string;
  readonly msgType: 'text' | 'interactive' | 'file' | 'image';
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
  /** Register the card.action.trigger callback. */
  onCardAction?(handler: (action: CardAction) => void): void;
  /** Add one emoji reaction; resolves the reaction id. */
  addReaction(messageId: string, emojiType: string): Promise<string>;
  /** Remove one reaction previously added by this bot. */
  removeReaction(messageId: string, reactionId: string): Promise<void>;
  /** Upload one file and return its Feishu file_key. */
  uploadFile(fileName: string, bytes: Uint8Array): Promise<string>;
  /** Upload one image message and return its Feishu image_key. */
  uploadImage(bytes: Uint8Array): Promise<string>;
  /** Download a message resource (image/file), enforcing a byte limit. */
  downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType?: string }>;
  createMessage(input: CreateMessageInput): Promise<{ messageId: string }>;
  replyMessage(input: ReplyMessageInput): Promise<{ messageId: string }>;
  patchCard(messageId: string, card: FeishuCard): Promise<void>;
  /** The bot's own open id, when resolved (group @ gate). */
  getBotOpenId?(): string | undefined;
  /** Retry bot identity resolution (group @ gate). */
  refreshBotOpenId?(): Promise<string | undefined>;
  /** Cached bot display name, resolved once at startup. */
  getBotName?(): string | undefined;
  /** Long-connection status and start time, when known. */
  getConnectionStatus?(): { readonly ready: boolean; readonly since?: number };
}
