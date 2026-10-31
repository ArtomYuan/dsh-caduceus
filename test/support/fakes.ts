/**
 * Injected fakes for the second-slice tests.
 *
 * Nothing here touches the network, dsh, or the real `~/.dsh`; every path a
 * test uses is inside a `mkdtemp` directory created by the test.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm';

import type { AgentLike, AgentsLike, SessionLike, SessionTitleLike } from '../../src/bridge/types.js';
import type { LoggerLike } from '../../src/logger.js';
import type { SessionOwnershipMeta } from '../../src/ownership.js';
import type { Clock, TimerHandle } from '../../src/render/stream.js';
import type {
  CreateMessageInput,
  FeishuApi,
  ReplyMessageInput,
} from '../../src/transport/feishu-api.js';
import {
  FeishuApiError,
  type FeishuCard,
  type InboundMessage,
  type ReplyOptions,
  type ReplyPayload,
  type SendOptions,
  type SentMessage,
  type Transport,
} from '../../src/transport/types.js';

export type TransportCall =
  | {
      readonly op: 'sendText';
      readonly messageId: string;
      readonly chatId: string;
      readonly text: string;
      readonly uuid?: string;
    }
  | {
      readonly op: 'sendCard';
      readonly messageId: string;
      readonly chatId: string;
      readonly card: FeishuCard;
      readonly uuid?: string;
    }
  | {
      readonly op: 'updateCard';
      readonly messageId: string;
      readonly card: FeishuCard;
    }
  | {
      readonly op: 'reply';
      readonly messageId: string;
      readonly chatId: string;
      readonly replyTo: string;
      readonly payload: ReplyPayload;
      readonly threadId?: string;
      readonly uuid?: string;
    };

export interface FakeTransportOptions {
  /** The bot's own open id the bridge uses for the group @ gate. */
  readonly botOpenId?: string;
}

/** Recording transport double. */
export class FakeTransport implements Transport {
  readonly calls: TransportCall[] = [];
  startCount = 0;
  stopCount = 0;
  /** When set, the next `updateCard` throws once (final-edit fallback tests). */
  failUpdateCardWith: Error | undefined;
  /** When set, the next card create (sendCard or card reply) throws once. */
  failCardCreateWith: Error | undefined;
  readonly #botOpenId: string | undefined;
  private handler: ((message: InboundMessage) => void) | undefined;
  private seq = 0;

  constructor(options: FakeTransportOptions = {}) {
    this.#botOpenId = options.botOpenId;
  }

  getBotOpenId(): string | undefined {
    return this.#botOpenId;
  }

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  async sendText(
    chatId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<SentMessage> {
    const messageId = this.nextId();
    this.calls.push({
      op: 'sendText',
      messageId,
      chatId,
      text,
      ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
    });
    return { messageId };
  }

  async sendCard(
    chatId: string,
    card: FeishuCard,
    options: SendOptions = {},
  ): Promise<SentMessage> {
    if (this.failCardCreateWith !== undefined) {
      const error = this.failCardCreateWith;
      this.failCardCreateWith = undefined;
      throw error;
    }
    const messageId = this.nextId();
    this.calls.push({
      op: 'sendCard',
      messageId,
      chatId,
      card,
      ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
    });
    return { messageId };
  }

  async updateCard(messageId: string, card: FeishuCard): Promise<void> {
    if (this.failUpdateCardWith !== undefined) {
      const error = this.failUpdateCardWith;
      this.failUpdateCardWith = undefined;
      throw error;
    }
    this.calls.push({ op: 'updateCard', messageId, card });
  }

  async reply(
    chatId: string,
    messageId: string,
    payload: ReplyPayload,
    options: ReplyOptions = {},
  ): Promise<SentMessage> {
    if (payload.kind === 'card' && this.failCardCreateWith !== undefined) {
      const error = this.failCardCreateWith;
      this.failCardCreateWith = undefined;
      throw error;
    }
    const created = this.nextId();
    this.calls.push({
      op: 'reply',
      messageId: created,
      chatId,
      replyTo: messageId,
      payload,
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
    });
    return { messageId: created };
  }

  /** Deliver one inbound message through the registered handler (test seam). */
  deliver(message: InboundMessage): void {
    this.handler?.(message);
  }

  private nextId(): string {
    this.seq += 1;
    return `msg-${this.seq}`;
  }
}

/** Every text payload the transport recorded (replies and plain sends, in order). */
export function recordedTexts(transport: FakeTransport): string[] {
  const texts: string[] = [];
  for (const call of transport.calls) {
    if (call.op === 'sendText') texts.push(call.text);
    else if (call.op === 'reply' && call.payload.kind === 'text') texts.push(call.payload.text);
  }
  return texts;
}

/** Every card the transport created (via sendCard or reply). */
export function recordedCards(
  transport: FakeTransport,
): { readonly messageId: string; readonly card: FeishuCard }[] {
  const cards: { messageId: string; card: FeishuCard }[] = [];
  for (const call of transport.calls) {
    if (call.op === 'sendCard') cards.push({ messageId: call.messageId, card: call.card });
    else if (call.op === 'reply' && call.payload.kind === 'card') {
      cards.push({ messageId: call.messageId, card: call.payload.card });
    }
  }
  return cards;
}

/** Cards patched in place. */
export function patchedCards(
  transport: FakeTransport,
): { readonly messageId: string; readonly card: FeishuCard }[] {
  return transport.calls
    .filter((call): call is Extract<TransportCall, { op: 'updateCard' }> => call.op === 'updateCard')
    .map((call) => ({ messageId: call.messageId, card: call.card }));
}

/** Raw Feishu API double: records calls and can fail replies on demand. */
export class FakeFeishuApi implements FeishuApi {
  readonly created: CreateMessageInput[] = [];
  readonly replied: ReplyMessageInput[] = [];
  readonly patched: { readonly messageId: string; readonly card: FeishuCard }[] = [];
  readonly failReplyCodes: number[] = [];
  private handler: ((message: InboundMessage) => void) | undefined;
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.handler = handler;
  }

  async createMessage(input: CreateMessageInput): Promise<{ messageId: string }> {
    this.created.push(input);
    return { messageId: `api-created-${this.created.length}` };
  }

  async replyMessage(input: ReplyMessageInput): Promise<{ messageId: string }> {
    this.replied.push(input);
    const code = this.failReplyCodes.shift();
    if (code !== undefined) throw new FeishuApiError(`reply failed (${code})`, code);
    return { messageId: `api-reply-${this.replied.length}` };
  }

  async patchCard(messageId: string, card: FeishuCard): Promise<void> {
    this.patched.push({ messageId, card });
  }
}

/** Live-agent double. */
export class FakeAgent implements AgentLike {
  readonly id: string;
  readonly session: SessionLike;
  readonly followups: UserMessage[] = [];
  readonly steers: UserMessage[] = [];
  readonly cancels: { readonly kind: 'user' }[] = [];

  constructor(sessionId: string) {
    this.id = sessionId;
    this.session = { id: sessionId };
  }

  followup(message: UserMessage): void {
    this.followups.push(message);
  }

  steer(message: UserMessage): void {
    this.steers.push(message);
  }

  cancel(cause: { kind: 'user' }): void {
    this.cancels.push(cause);
  }
}

/** `ctx.get('agents')` double with gates for serialization tests. */
export class FakeAgents implements AgentsLike {
  readonly live = new Map<string, FakeAgent>();
  readonly created: string[] = [];
  readonly createCalls: {
    readonly sessionId: string;
    readonly meta: { readonly cwd: string; readonly caduceus: SessionOwnershipMeta };
  }[] = [];
  readonly resumed: string[] = [];
  readonly failResume = new Set<string>();
  /** When set, the next create rejects once (for /new failure tests). */
  failCreateWith: Error | undefined;
  createGate: Promise<void> | undefined;
  resumeGate: Promise<void> | undefined;

  async create(options: {
    readonly sessionId: string;
    readonly meta: { readonly cwd: string; readonly caduceus: SessionOwnershipMeta };
  }): Promise<{ readonly agent: FakeAgent }> {
    this.createCalls.push({ sessionId: options.sessionId, meta: options.meta });
    if (this.failCreateWith !== undefined) {
      const error = this.failCreateWith;
      this.failCreateWith = undefined;
      throw error;
    }
    this.created.push(options.sessionId);
    if (this.createGate !== undefined) await this.createGate;
    const agent = new FakeAgent(options.sessionId);
    this.live.set(options.sessionId, agent);
    return { agent };
  }

  async resume(options: { readonly resumeSessionId: string }): Promise<{ readonly agent: FakeAgent }> {
    this.resumed.push(options.resumeSessionId);
    if (this.resumeGate !== undefined) await this.resumeGate;
    if (this.failResume.has(options.resumeSessionId)) {
      throw new Error(`no persisted log for ${options.resumeSessionId}`);
    }
    const agent = new FakeAgent(options.resumeSessionId);
    this.live.set(options.resumeSessionId, agent);
    return { agent };
  }

  get(sessionId: string): FakeAgent | undefined {
    return this.live.get(sessionId);
  }
}

/** Deterministic clock for the card-stream throttle tests. */
export class FakeClock implements Clock {
  private current = 0;
  private timers: { at: number; callback: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ at: this.current + delayMs, callback, id });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Advance time and run every timer that became due (in order). */
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers
      .filter((timer) => timer.at <= this.current)
      .sort((left, right) => left.at - right.at);
    this.timers = this.timers.filter((timer) => timer.at > this.current);
    for (const timer of due) timer.callback();
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

/** `ctx.get('sessionTitle')` double. */
export class FakeTitleService implements SessionTitleLike {
  readonly titles = new Map<string, string>();
  readonly renamed: { readonly sessionId: string; readonly title: string }[] = [];
  /** Titles that must fail with `SessionTitleInvalidError`. */
  readonly invalidTitles = new Set<string>();

  rename(session: unknown, title: string): unknown {
    const sessionId = (session as { id: string }).id;
    const normalized = title.trim();
    if (normalized.length === 0 || this.invalidTitles.has(normalized)) {
      const error = new Error('title normalizes to empty');
      error.name = 'SessionTitleInvalidError';
      throw error;
    }
    this.titles.set(sessionId, normalized);
    this.renamed.push({ sessionId, title: normalized });
    return { title: normalized, source: { kind: 'user' } };
  }

  get(session: unknown): { readonly title?: string } | undefined {
    const sessionId = (session as { id: string }).id;
    const title = this.titles.get(sessionId);
    return title === undefined ? undefined : { title };
  }
}

/** Recording logger double. */
export class FakeLogger implements LoggerLike {
  readonly entries: { readonly level: string; readonly message: string }[] = [];

  info(message: string): void {
    this.entries.push({ level: 'info', message });
  }

  warn(message: string): void {
    this.entries.push({ level: 'warn', message });
  }

  error(message: string): void {
    this.entries.push({ level: 'error', message });
  }

  debug(message: string): void {
    this.entries.push({ level: 'debug', message });
  }
}

let inboundSeq = 0;

/** Build one inbound test message. */
export function inbound(
  text: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  inboundSeq += 1;
  return {
    messageId: `om_${inboundSeq}`,
    chatId: 'oc_chat',
    // Default to p2p so tests unrelated to the group @ gate need no mention.
    chatType: 'p2p',
    senderOpenId: 'ou_user',
    mentions: [],
    text,
    createdAt: 0,
    ...overrides,
  };
}

/** The concatenated text blocks of one user message. */
export function userMessageText(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Let queued microtasks/timers progress in async tests. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
