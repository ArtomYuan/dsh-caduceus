/**
 * The real Feishu transport: one `WSClient` long connection for inbound
 * `im.message.receive_v1` events plus one `Client` for outbound REST calls.
 *
 * This is the ONLY module that imports `@larksuiteoapi/node-sdk`; everything
 * else talks to the {@link FeishuApi} seam, so tests never need credentials or
 * a network connection.
 *
 * @module dsh-caduceus/transport/lark
 */
import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';

import type { LoggerLike } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { CreateMessageInput, FeishuApi, ReplyMessageInput } from './feishu-api.js';
import {
  normalizeCardAction,
  normalizeMessageEvent,
  type RawCardActionLike,
  type RawMessageEventLike,
} from './normalize.js';
import { formatGateLine } from '../gate.js';
import { FeishuApiError } from './types.js';
import type { CardAction, FeishuCard, InboundMessage } from './types.js';

export interface LarkFeishuApiOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly logger?: LoggerLike;
}

interface MessageResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: {
    readonly message_id?: string;
  };
}

interface ReactionResponse {
  readonly code?: number;
  readonly msg?: string;
  readonly data?: {
    readonly reaction_id?: string;
  };
}

/** Long-connection Feishu implementation of {@link FeishuApi}. */
export class LarkFeishuApi implements FeishuApi {
  private readonly client: Client;
  private readonly ws: WSClient;
  private readonly dispatcher: EventDispatcher;
  private readonly logger: LoggerLike;
  private handler: ((message: InboundMessage) => void) | undefined;
  private cardActionHandler: ((action: CardAction) => void) | undefined;
  private running = false;
  private botOpenId: string | undefined;
  private botName: string | undefined;
  private startedAt: number | undefined;

  constructor(options: LarkFeishuApiOptions) {
    this.logger = options.logger ?? silentLogger();
    this.client = new Client({ appId: options.appId, appSecret: options.appSecret });
    this.dispatcher = new EventDispatcher({});
    this.dispatcher.register({
      'card.action.trigger': (data: unknown) => {
        const action = normalizeCardAction(data as RawCardActionLike);
        if (action !== undefined) this.cardActionHandler?.(action);
      },
      'im.message.receive_v1': (data: unknown) => {
        const raw = data as RawMessageEventLike;
        const senderType = raw.sender?.sender_type;
        if (senderType !== 'user') {
          // Priority #1: a bot/app event must never enter a session (real
          // incident: an app self-improvement notice became the first prompt
          // and the fallback title). Log the gate decision at info so the drop
          // is diagnosable from the file log.
          this.logger.info(
            formatGateLine(
              { accept: false, reason: 'bot-sender' },
              {
                chatId: raw.message.chat_id,
                ...(raw.message.thread_id === undefined && raw.message.root_id === undefined
                  ? {}
                  : { threadId: raw.message.thread_id ?? raw.message.root_id }),
                senderOpenId: raw.sender?.sender_id?.open_id ?? '',
                senderType: senderType ?? 'missing',
              },
            ),
          );
          return;
        }
        const message = normalizeMessageEvent(raw);
        if (message === undefined) {
          this.logger.debug('ignoring unsupported Feishu message event');
          return;
        }
        this.handler?.(message);
      },
    });
    this.ws = new WSClient({ appId: options.appId, appSecret: options.appSecret });
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  onCardAction(handler: (action: CardAction) => void): void {
    this.cardActionHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.resolveBotOpenId();
    await this.ws.start({ eventDispatcher: this.dispatcher });
    this.running = true;
    this.startedAt = Date.now();
    this.logger.info('feishu long connection started');
  }

  /** Resolve the bot's own open id once, best-effort (group @ gate). */
  private async resolveBotOpenId(): Promise<void> {
    try {
      const response = (await this.client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      })) as {
        bot?: { open_id?: string; name?: string; app_name?: string };
        data?: { open_id?: string; name?: string; app_name?: string };
      };
      const bot = response.bot ?? response.data;
      const name = bot?.name ?? bot?.app_name;
      if (name !== undefined && name.length > 0) this.botName = name;
      const openId = response.bot?.open_id ?? response.data?.open_id;
      if (typeof openId === 'string' && openId.length > 0) {
        this.botOpenId = openId;
        this.logger.debug(`resolved bot open id ${openId}`);
      }
    } catch (error) {
      this.logger.warn(
        `could not resolve bot open id; group @ gate will accept any mention: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The bot's own open id, or `undefined` until resolved. */
  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  getBotName(): string | undefined {
    return this.botName;
  }

  getConnectionStatus(): { readonly ready: boolean; readonly since?: number } {
    return {
      ready: this.running,
      ...(this.startedAt === undefined ? {} : { since: this.startedAt }),
    };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.ws.close({ force: true });
    this.logger.info('feishu long connection stopped');
  }

  async createMessage(input: CreateMessageInput): Promise<{ messageId: string }> {
    const response = (await this.client.im.v1.message.create({
      data: {
        receive_id: input.chatId,
        msg_type: input.msgType,
        content: input.content,
        ...(input.uuid === undefined ? {} : { uuid: input.uuid }),
      },
      params: { receive_id_type: 'chat_id' },
    })) as MessageResponse;
    return { messageId: this.messageIdOf(response, 'im.v1.message.create') };
  }

  async replyMessage(input: ReplyMessageInput): Promise<{ messageId: string }> {
    const response = (await this.client.im.v1.message.reply({
      data: {
        content: input.content,
        msg_type: input.msgType,
        ...(input.replyInThread ? { reply_in_thread: true } : {}),
        ...(input.uuid === undefined ? {} : { uuid: input.uuid }),
      },
      path: { message_id: input.messageId },
    })) as MessageResponse;
    return { messageId: this.messageIdOf(response, 'im.v1.message.reply') };
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    const response = (await this.client.im.v1.messageReaction.create({
      data: { reaction_type: { emoji_type: emojiType } },
      path: { message_id: messageId },
    })) as ReactionResponse;
    this.assertOk(response, 'im.v1.message.reaction.create');
    const reactionId = response.data?.reaction_id;
    if (reactionId === undefined || reactionId.length === 0) {
      throw new FeishuApiError('feishu im.v1.message.reaction.create returned no reaction_id', -1);
    }
    return reactionId;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = (await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    })) as ReactionResponse;
    this.assertOk(response, 'im.v1.message.reaction.delete');
  }

  async patchCard(messageId: string, card: FeishuCard): Promise<void> {
    const response = (await this.client.im.v1.message.patch({
      data: { content: JSON.stringify(card) },
      path: { message_id: messageId },
    })) as MessageResponse;
    this.assertOk(response, 'im.v1.message.patch');
  }

  private messageIdOf(response: MessageResponse, operation: string): string {
    this.assertOk(response, operation);
    const messageId = response.data?.message_id;
    if (messageId === undefined || messageId.length === 0) {
      throw new FeishuApiError(`feishu ${operation} returned no message_id`, -1);
    }
    return messageId;
  }

  private assertOk(response: { readonly code?: number; readonly msg?: string }, operation: string): void {
    const code = response.code ?? -1;
    if (code !== 0) {
      throw new FeishuApiError(`feishu ${operation} failed: ${response.msg ?? 'unknown error'}`, code);
    }
  }
}

/** Create the production transport implementation. */
export function createLarkFeishuApi(options: LarkFeishuApiOptions): FeishuApi {
  return new LarkFeishuApi(options);
}
