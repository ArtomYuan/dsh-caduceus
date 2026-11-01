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
import { stripLeadingMentions } from '../mentions.js';
import type { CardAction, InboundMessage } from './types.js';

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
      readonly name?: string;
      readonly id?: { readonly open_id?: string };
    }[];
  };
}

const AT_TAG_PATTERN = /<at[^>]*>(.*?)<\/at>/gs;

/** Message types the v0.1 surface handles (attachments are v0.2). */
const SUPPORTED_MESSAGE_TYPES = new Set(['text']);

/**
 * Normalize one raw event.
 *
 * @returns the normalized message, or `undefined` for unsupported/malformed
 *   payloads or empty text.
 */
export function normalizeMessageEvent(
  raw: RawMessageEventLike,
  botOpenId?: string,
): InboundMessage | undefined {
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

  // Preserve the display text inside <at> tags first: key -> @name replacement
  // below needs the placeholder text to still be present.
  text = text.replace(AT_TAG_PATTERN, (_match, inner: string) => ` @${inner.trim().replace(/^@/, '')} `);
  text = text.replace(/\r\n?/g, '\n');

  const rawMentions = message.mentions ?? [];
  const entries = rawMentions
    .map((mention) => ({
      key: mention.key,
      name: mention.name,
      openId: mention.id?.open_id,
    }))
    .filter((entry) => entry.key !== undefined || entry.name !== undefined || entry.openId !== undefined);

  if (entries.length === 0) {
    // No mention metadata: keep the previous behaviour (strip placeholders).
    text = text.trim();
    text = stripLeadingMentions(text).trim();
  } else {
    // 1) Remove the bot's own mention(s) entirely (agent need not see "@self").
    for (const entry of entries) {
      const own = botOpenId !== undefined && botOpenId.length > 0 && entry.openId === botOpenId;
      if (!own) continue;
      if (entry.key !== undefined && entry.key.length > 0) text = text.split(entry.key).join(' ');
      if (entry.name !== undefined && entry.name.length > 0) text = text.split(`@${entry.name}`).join(' ');
    }
    // 2) Replace remaining placeholder keys with @display-name (longest first,
    // so @_user_10 is never clobbered by @_user_1).
    const replaceable = entries
      .filter((entry) => entry.name !== undefined && entry.name.length > 0 && entry.key !== undefined)
      .sort((left, right) => (right.key?.length ?? 0) - (left.key?.length ?? 0));
    for (const entry of replaceable) {
      text = text.split(entry.key as string).join(`@${entry.name as string}`);
    }
    text = text.replace(/[ \t]{2,}/g, ' ').trim();
  }
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

/** Raw `card.action.trigger` payload fields used by the surface. */
export interface RawCardActionLike {
  readonly open_id?: string;
  readonly operator?: { readonly open_id?: string };
  readonly open_message_id?: string;
  readonly open_chat_id?: string;
  readonly context?: {
    readonly open_message_id?: string;
    readonly open_chat_id?: string;
  };
  readonly action?: {
    readonly value?: Record<string, unknown>;
    readonly form_value?: Record<string, unknown>;
  };
}

/** Normalize Feishu's card click into the transport's CardAction. */
export function normalizeCardAction(raw: RawCardActionLike): CardAction | undefined {
  const operatorOpenId = raw.operator?.open_id ?? raw.open_id ?? '';
  const messageId = raw.context?.open_message_id ?? raw.open_message_id ?? '';
  const chatId = raw.context?.open_chat_id ?? raw.open_chat_id ?? '';
  const value = raw.action?.value;
  if (operatorOpenId.length === 0 || messageId.length === 0) return undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  const rawForm = raw.action?.form_value;
  const formValue =
    typeof rawForm === 'object' && rawForm !== null
      ? Object.fromEntries(
          Object.entries(rawForm).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
  return {
    operatorOpenId,
    messageId,
    chatId,
    value,
    ...(formValue === undefined || Object.keys(formValue).length === 0 ? {} : { formValue }),
  };
}
