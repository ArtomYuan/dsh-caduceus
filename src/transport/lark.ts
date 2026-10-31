/**
 * The real Feishu transport: one `WSClient` long connection for inbound
 * `im.message.receive_v1` events plus one `Client` for outbound REST calls.
 *
 * This is the ONLY module that imports `@larksuiteoapi/node-sdk`; everything
 * else talks to the {@link FeishuApi} seam, so tests never need credentials or
 * a network connection.
 *
 * @module @artomyuan/dsh-caduceus/transport/lark
 */
import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';

import type { LoggerLike } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { CreateMessageInput, FeishuApi, ReplyMessageInput } from './feishu-api.js';
import { normalizeMessageEvent, type RawMessageEventLike } from './normalize.js';
import { FeishuApiError } from './types.js';
import type { FeishuCard, InboundMessage } from './types.js';

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

/** Long-connection Feishu implementation of {@link FeishuApi}. */
export class LarkFeishuApi implements FeishuApi {
  private readonly client: Client;
  private readonly ws: WSClient;
  private readonly dispatcher: EventDispatcher;
  private readonly logger: LoggerLike;
  private handler: ((message: InboundMessage) => void) | undefined;
  private running = false;
  private botOpenId: string | undefined;

  constructor(options: LarkFeishuApiOptions) {
    this.logger = options.logger ?? silentLogger();
    this.client = new Client({ appId: options.appId, appSecret: options.appSecret });
    this.dispatcher = new EventDispatcher({});
    this.dispatcher.register({
      'im.message.receive_v1': (data: unknown) => {
        const raw = data as RawMessageEventLike;
        const senderType = raw.sender?.sender_type;
        if (senderType !== 'user') {
          // Priority #1: a bot/app event must never enter a session (real
          // incident: an app self-improvement notice became the first prompt
          // and the fallback title).
          this.logger.debug(
            `ignoring non-human Feishu message (sender_type=${senderType ?? 'missing'})`,
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

  async start(): Promise<void> {
    if (this.running) return;
    await this.resolveBotOpenId();
    await this.ws.start({ eventDispatcher: this.dispatcher });
    this.running = true;
    this.logger.info('feishu long connection started');
  }

  /** Resolve the bot's own open id once, best-effort (group @ gate). */
  private async resolveBotOpenId(): Promise<void> {
    try {
      const response = (await this.client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      })) as { bot?: { open_id?: string }; data?: { open_id?: string } };
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

  private assertOk(response: MessageResponse, operation: string): void {
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
