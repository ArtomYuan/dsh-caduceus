/**
 * Pure normalization of a Feishu `im.message.receive_v1` payload.
 *
 * The topic identity is the whole point of this module: the bridge keys
 * sessions by `(chatId, threadId)`, and the bot must answer in the same topic
 * (design doc A6). Feishu puts the topic id in `thread_id`; older/related
 * shapes only carry `root_id`, so the rule is:
 *
 *     threadId = message.thread_id ?? message.root_id
 *
 * Non-human senders (`sender.sender_type !== 'user'`) are dropped FIRST, before
 * any other judgement: a bot/app event (e.g. an app self-improvement notice)
 * must never become a session prompt or a fallback title. Feishu events from
 * humans carry `sender_type: 'user'`; a missing sender_type is treated as
 * non-human on purpose (fail closed).
 *
 * Mention open ids are preserved so the bridge can enforce the group @ gate.
 *
 * @module dsh-caduceus/transport/normalize
 */
import type { InboundMessage } from './types.js';

/** Structural subset of the SDK's `RawMessageEvent` (no SDK import needed). */
export interface RawMessageEventLike {
  readonly sender?: {
    readonly sender_id?: {
      readonly open_id?: string;
    };
    readonly sender_type?: string;
  };
  readonly message: {
    readonly message_id: string;
    readonly chat_id: string;
    readonly chat_type?: string;
    readonly message_type: string;
    readonly content: string;
    readonly create_time?: string;
    readonly thread_id?: string;
    readonly root_id?: string;
    readonly parent_id?: string;
    readonly mentions?: readonly {
      readonly key?: string;
      readonly id?: { readonly open_id?: string };
    }[];
  };
}

const MENTION_PATTERN = /<at[^>]*>.*?<\/at>/g;

/** Message types the v0.1 surface handles (attachments are v0.2). */
const SUPPORTED_MESSAGE_TYPES = new Set(['text']);

/**
 * Normalize one raw event.
 *
 * @returns the normalized message, or `undefined` for unsupported/malformed
 *   payloads or empty text.
 */
export function normalizeMessageEvent(raw: RawMessageEventLike): InboundMessage | undefined {
  // Priority #1: only human messages may enter a session.
  const senderType = raw.sender?.sender_type;
  if (senderType !== 'user') return undefined;

  const message = raw.message;
  if (!SUPPORTED_MESSAGE_TYPES.has(message.message_type)) return undefined;

  let text: string;
  try {
    const parsed = JSON.parse(message.content) as { text?: unknown };
    if (typeof parsed.text !== 'string') return undefined;
    text = parsed.text;
  } catch {
    return undefined;
  }

  text = text.replace(MENTION_PATTERN, ' ').replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) return undefined;

  const threadId = firstNonEmpty(message.thread_id, message.root_id);
  const rootId = firstNonEmpty(message.root_id);
  const mentions = (message.mentions ?? [])
    .map((mention) => mention.id?.open_id)
    .filter((openId): openId is string => typeof openId === 'string' && openId.length > 0);
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId: raw.sender?.sender_id?.open_id ?? '',
    ...(mentions.length === 0 ? {} : { mentions }),
    text,
    ...(threadId === undefined ? {} : { threadId }),
    ...(rootId === undefined ? {} : { rootId }),
    createdAt: Number(message.create_time) || 0,
  };
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}
