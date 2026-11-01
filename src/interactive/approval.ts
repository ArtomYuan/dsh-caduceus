/**
 * `approval/request` answerer: send an approval card, wait for a button click
 * (or timeout/abort), and return only closed dsh approval outcomes.
 *
 * Fail-closed rules:
 * - approvalCard disabled / no owner context -> `unavailable` (never prompt);
 * - card send fails -> log ERROR and `cancelled`;
 * - timeout or abort -> `cancelled`;
 * - callback handler resolves the pending entry with the chosen outcome.
 *
 * @module dsh-caduceus/interactive/approval
 */
import { approvalCard, approvalTerminalCard } from './cards.js';
import type { InteractiveContext, InteractiveHost } from './types.js';

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalRequestLike {
  readonly toolName: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export type ApprovalAnswerer = (
  request: ApprovalRequestLike,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome>;

export function createApprovalAnswerer(
  host: InteractiveHost,
  contextFor: () => InteractiveContext | undefined,
): ApprovalAnswerer {
  return async (request) => {
    if (!host.config.approvalCard) return 'unavailable';
    const context = contextFor();
    if (context === undefined) return 'unavailable';

    let settle!: (outcome: ApprovalOutcome) => void;
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      settle = resolve;
    });
    const entry = host.pending.add({
      kind: 'approval',
      scopeKey: context.scopeKey,
      chatId: context.chatId,
      ownerOpenId: context.ownerOpenId,
      sessionId: context.sessionId,
      createdAt: host.clock.now(),
      resolve: (value) => settle(value as ApprovalOutcome),
      reject: () => settle('cancelled'),
      meta: { toolName: request.toolName, message: request.reason },
    });
    const card = approvalCard(
      entry.id,
      context.sessionId,
      request.toolName,
      request.reason,
    );

    let timer: unknown;
    const onAbort = (): void => {
      if (host.pending.delete(entry.id) === undefined) return;
      void host
        .updateCard(entry.cardMessageId ?? '', approvalTerminalCard(request.toolName, '已取消'))
        .catch(() => undefined);
      settle('cancelled');
    };
    const cleanup = (): void => {
      if (timer !== undefined) host.clock.clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    entry.cleanup = cleanup;

    try {
      entry.cardMessageId = (await host.sendCard(context.chatId, card)).messageId;
    } catch (error) {
      host.pending.delete(entry.id);
      host.logger.error(
        `approval card send failed; failing closed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'cancelled';
    }

    timer = host.clock.setTimeout(() => {
      if (host.pending.delete(entry.id) === undefined) return;
      void host
        .updateCard(entry.cardMessageId ?? '', approvalTerminalCard(request.toolName, '已过期'))
        .catch(() => undefined);
      settle('cancelled');
    }, host.config.timeoutMs);

    if (request.signal?.aborted === true) {
      onAbort();
      return outcome;
    }
    request.signal?.addEventListener('abort', onAbort, { once: true });
    return outcome;
  };
}
