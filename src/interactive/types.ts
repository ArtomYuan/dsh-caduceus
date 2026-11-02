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
  /** Optional permission summary line for approval cards. */
  readonly permissionLine?: string;
}

/** A Cordis context (the plugin root or an agent scope); only `on` is needed. */
export interface EventScopeLike {
  on(name: string, listener: (...args: any[]) => any): unknown;
}

export function logPrefix(value: string, max = 12): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Short, safe description of a value for the attach-skipped diagnostic. */
export function describeScope(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type !== 'object') return type;
  let keys: string[] = [];
  try {
    keys = Object.keys(value as Record<string, unknown>).slice(0, 6);
  } catch {
    return 'object (unreadable keys)';
  }
  return keys.length === 0 ? 'object keys=none' : `object keys=${keys.join(',')}`;
}

export function isEventScope(value: unknown): value is EventScopeLike {
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
  sendCard(
    sessionId: string,
    card: FeishuCard,
  ): Promise<{ readonly messageId: string; readonly threadId?: string }>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
}

/** CardAction is defined by the transport seam. */
