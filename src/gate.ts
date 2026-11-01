/**
 * Inbound trigger gate: one decision per message, one log line per decision.
 *
 * Every decision is operator-visible (info level) because a silently dropped
 * message was previously impossible to diagnose on a real deployment:
 *
 * ```text
 * gate accept: p2p chat=oc_xxx thread=- sender=ou_yyy
 * gate drop: no-mention chat=… thread=omt_… sender=ou_…
 * gate drop: bot-sender sender_type=app chat=… thread=… sender=…
 * ```
 *
 * Pure classifier + formatter; the bridge and the transport both use it.
 *
 * @module dsh-caduceus/gate
 */
import type { LoggerLike } from './logger.js';
import type { ChatType } from './transport/types.js';

export type GateAcceptReason = 'p2p' | 'mentioned';
export type GateDropReason =
  | 'bot-sender'
  | 'not-allowed-chat'
  | 'not-allowed-user'
  | 'empty-text'
  | 'no-mention';

export type GateDecision =
  | { readonly accept: true; readonly reason: GateAcceptReason }
  | { readonly accept: false; readonly reason: GateDropReason };

export interface GateInput {
  readonly chatType: ChatType;
  readonly chatId: string;
  readonly threadId?: string;
  readonly senderOpenId: string;
  /** Raw Feishu `sender_type` when known (bridge only ever sees human messages). */
  readonly senderType?: string;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly botOpenId?: string;
  readonly allowedChats: readonly string[];
  readonly allowedUsers: readonly string[];
}

/** Classify one inbound message; the first failing rule wins. */
export function evaluateGate(input: GateInput): GateDecision {
  // Priority #1: never let a bot/app message into a session (defence in depth;
  // the transport already drops them before normalization).
  if (input.senderType !== undefined && input.senderType !== 'user') {
    return { accept: false, reason: 'bot-sender' };
  }
  if (input.allowedChats.length > 0 && !input.allowedChats.includes(input.chatId)) {
    return { accept: false, reason: 'not-allowed-chat' };
  }
  if (input.allowedUsers.length > 0 && !input.allowedUsers.includes(input.senderOpenId)) {
    return { accept: false, reason: 'not-allowed-user' };
  }
  if (input.text.trim().length === 0) {
    return { accept: false, reason: 'empty-text' };
  }
  if (input.chatType === 'p2p') {
    return { accept: true, reason: 'p2p' };
  }
  const mentions = input.mentions ?? [];
  const botOpenId = input.botOpenId;
  if (botOpenId !== undefined && botOpenId.length > 0) {
    if (mentions.includes(botOpenId)) return { accept: true, reason: 'mentioned' };
  } else if (mentions.length > 0) {
    // bot/v3/info unavailable: accept any mention rather than dropping every
    // group message; the line still records the decision for diagnosis.
    return { accept: true, reason: 'mentioned' };
  }
  return { accept: false, reason: 'no-mention' };
}

export interface GateLogInfo {
  readonly chatId: string;
  readonly threadId?: string;
  readonly senderOpenId: string;
  readonly senderType?: string;
}

function prefix(value: string | undefined, length = 12): string {
  const text = (value ?? '').slice(0, length);
  return text.length > 0 ? text : '-';
}

/** Format exactly one gate line (exported for tests). */
export function formatGateLine(decision: GateDecision, info: GateLogInfo): string {
  const context = `chat=${prefix(info.chatId)} thread=${prefix(info.threadId)} sender=${prefix(
    info.senderOpenId,
  )}`;
  if (decision.accept) return `gate accept: ${decision.reason} ${context}`;
  const senderType =
    decision.reason === 'bot-sender' ? ` sender_type=${info.senderType ?? 'missing'}` : '';
  return `gate drop: ${decision.reason}${senderType} ${context}`;
}

/** Emit the decision at info level (the file log's default threshold). */
export function logGate(logger: LoggerLike, decision: GateDecision, info: GateLogInfo): void {
  logger.info(formatGateLine(decision, info));
}
