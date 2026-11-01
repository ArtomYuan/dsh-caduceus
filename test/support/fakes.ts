/**
 * Injected fakes for the second-slice tests.
 *
 * Nothing here touches the network, dsh, or the real `~/.dsh`; every path a
 * test uses is inside a `mkdtemp` directory created by the test.
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm';

import type {
  AgentLike,
  AgentPresetsLike,
  AgentsLike,
  SessionLike,
  SessionTitleLike,
} from '../../src/bridge/types.js';
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
  type CardAction,
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
  /** Reaction calls recorded for assertions. */
  readonly reactionCalls: {
    readonly action: 'add' | 'remove';
    readonly messageId: string;
    readonly emojiType?: string;
    readonly reactionId?: string;
  }[] = [];
  failAddReactionWith: Error | undefined;
  failRemoveReactionWith: Error | undefined;
  /** Attachment download calls/results. */
  readonly downloadCalls: {
    readonly messageId: string;
    readonly fileKey: string;
    readonly type: 'image' | 'file';
  }[] = [];
  downloadResult: { readonly bytes: Uint8Array; readonly contentType?: string } = {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'image/png',
  };
  failDownloadWith: Error | undefined;
  #reactionSeq = 0;
  #botOpenId: string | undefined;
  private handler: ((message: InboundMessage) => void) | undefined;
  private cardActionHandler: ((action: CardAction) => void) | undefined;
  private seq = 0;

  constructor(options: FakeTransportOptions = {}) {
    this.#botOpenId = options.botOpenId;
  }

  getBotOpenId(): string | undefined {
    return this.#botOpenId;
  }

  refreshBotOpenId(): Promise<string | undefined> {
    return Promise.resolve(this.#botOpenId);
  }

  /** Test seam: simulate bot/v3/info succeeding later. */
  setBotOpenId(openId: string | undefined): void {
    this.#botOpenId = openId;
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

  onCardAction(handler: (action: CardAction) => void): void {
    this.cardActionHandler = handler;
  }

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    this.reactionCalls.push({ action: 'add', messageId, emojiType });
    const failure = this.failAddReactionWith;
    if (failure !== undefined) {
      this.failAddReactionWith = undefined;
      throw failure;
    }
    this.#reactionSeq += 1;
    return `reaction-${this.#reactionSeq}`;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.reactionCalls.push({ action: 'remove', messageId, reactionId });
    const failure = this.failRemoveReactionWith;
    if (failure !== undefined) {
      this.failRemoveReactionWith = undefined;
      throw failure;
    }
  }

  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType?: string }> {
    this.downloadCalls.push({ messageId, fileKey, type });
    if (this.failDownloadWith !== undefined) {
      const failure = this.failDownloadWith;
      this.failDownloadWith = undefined;
      throw failure;
    }
    return this.downloadResult;
  }

  /** Deliver one card button click through the registered handler (test seam). */
  deliverCardAction(action: CardAction): void {
    this.cardActionHandler?.(action);
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
  readonly reactions: { action: 'add' | 'remove'; messageId: string; emojiType?: string; reactionId?: string }[] = [];
  failAddReactionWith: Error | undefined;
  private handler: ((message: InboundMessage) => void) | undefined;
  started = false;
  #reactionSeq = 0;

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

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    this.reactions.push({ action: 'add', messageId, emojiType });
    if (this.failAddReactionWith !== undefined) throw this.failAddReactionWith;
    this.#reactionSeq += 1;
    return `api-reaction-${this.#reactionSeq}`;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.reactions.push({ action: 'remove', messageId, reactionId });
  }

  async downloadResource(
    _messageId: string,
    _fileKey: string,
    _type: 'image' | 'file',
    _maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType?: string }> {
    return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
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
/** `ctx.get('agentPresets')` double: records mounts and can simulate failures. */
export class FakeAgentPresets implements AgentPresetsLike {
  readonly mountCalls: { readonly id: string | undefined }[] = [];
  /** Returned by `composedPreset`; undefined simulates a legacy unbound agent. */
  composedPresetValue: string | undefined;
  mountError: Error | undefined;

  async mount(_agentCtx: unknown, id?: string): Promise<unknown> {
    this.mountCalls.push({ id });
    if (this.mountError !== undefined) throw this.mountError;
    return { id: id ?? 'standard' };
  }

  composedPreset(_agentCtx: unknown): string | undefined {
    return this.composedPresetValue;
  }
}

export class FakeAgents implements AgentsLike {
  readonly live = new Map<string, FakeAgent>();
  readonly created: string[] = [];
  readonly createCalls: {
    readonly sessionId: string;
    readonly meta: {
      readonly cwd: string;
      readonly caduceus: SessionOwnershipMeta;
      readonly agentPreset?: string;
    };
  }[] = [];
  readonly setupCalls: unknown[] = [];
  readonly setupScopes: {
    readonly sessionId: string;
    readonly phase: 'create' | 'resume';
    readonly listeners: Map<string, (...args: any[]) => any>;
  }[] = [];
  readonly resumed: string[] = [];
  readonly failResume = new Set<string>();
  /** When set, the next create rejects once (for /new failure tests). */
  failCreateWith: Error | undefined;
  createGate: Promise<void> | undefined;
  resumeGate: Promise<void> | undefined;

  async create(options: {
    readonly sessionId: string;
    readonly meta: {
      readonly cwd: string;
      readonly caduceus: SessionOwnershipMeta;
      readonly agentPreset?: string;
    };
    readonly setup?: (agentCtx: unknown) => Promise<void> | void;
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
    if (options.setup !== undefined) {
      this.setupCalls.push({ sessionId: options.sessionId, phase: 'create' });
      await options.setup(this.#setupScope(options.sessionId, 'create'));
    }
    this.live.set(options.sessionId, agent);
    return { agent };
  }

  async resume(options: {
    readonly resumeSessionId: string;
    readonly setup?: (agentCtx: unknown) => Promise<void> | void;
  }): Promise<{ readonly agent: FakeAgent }> {
    this.resumed.push(options.resumeSessionId);
    if (this.resumeGate !== undefined) await this.resumeGate;
    if (this.failResume.has(options.resumeSessionId)) {
      throw new Error(`no persisted log for ${options.resumeSessionId}`);
    }
    const agent = new FakeAgent(options.resumeSessionId);
    if (options.setup !== undefined) {
      this.setupCalls.push({ sessionId: options.resumeSessionId, phase: 'resume' });
      await options.setup(this.#setupScope(options.resumeSessionId, 'resume'));
    }
    this.live.set(options.resumeSessionId, agent);
    return { agent };
  }

  #setupScope(sessionId: string, phase: 'create' | 'resume'): {
    readonly sessionId: string;
    readonly phase: 'create' | 'resume';
    readonly on: (name: string, listener: (...args: any[]) => any) => unknown;
    readonly listeners: Map<string, (...args: any[]) => any>;
  } {
    const listeners = new Map<string, (...args: any[]) => any>();
    const scope = {
      sessionId,
      phase,
      listeners,
      on: (name: string, listener: (...args: any[]) => any) => {
        listeners.set(name, listener);
        return listener;
      },
    };
    this.setupScopes.push(scope);
    return scope;
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
