/**
 * Shared seams for caduceus interactive cards (approval + user questions).
 *
 * The dsh services and the Cordis waterfall are adapted structurally so unit
 * tests never import dsh internals; the gateway wires the real transport and
 * agent scope at the edge.
 *
 * @module dsh-caduceus/interactive/types
 */
import type { LoggerLike } from '../logger.js';
import type { Clock } from '../render/stream.js';
import type { CardAction, FeishuCard } from '../transport/types.js';
export type { CardAction };
import type { PendingRegistry } from './pending.js';

export interface InteractiveConfig {
  /** Send approval cards (default true). */
  readonly approvalCard: boolean;
  /** Send question cards (default true). */
  readonly questionCard: boolean;
  /** How long a card waits before it expires (ms, default 300000). */
  readonly timeoutMs: number;
}

/** Where the card belongs and who may click it. */
export interface InteractiveContext {
  readonly scopeKey: string;
  readonly chatId: string;
  readonly ownerOpenId: string;
  readonly sessionId: string;
}

/** A scoped event bus (the agent's Cordis context); only `on` is needed. */
export interface AgentScopeLike {
  on(name: string, listener: (...args: any[]) => any): unknown;
}

export function isAgentScope(value: unknown): value is AgentScopeLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { on?: unknown }).on === 'function'
  );
}

/** What the approval/question answerers need from the runtime. */
export interface InteractiveHost {
  readonly config: InteractiveConfig;
  readonly logger: LoggerLike;
  readonly clock: Clock;
  readonly pending: PendingRegistry;
  sendCard(chatId: string, card: FeishuCard): Promise<{ readonly messageId: string }>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
}

/** CardAction is defined by the transport seam. */
