/**
 * Runtime that owns the pending registry, sends/patch cards, routes
 * `card.action.trigger` clicks, and installs the two agent-scoped answerers.
 *
 * @module dsh-caduceus/interactive/runtime
 */
import type { LoggerLike } from '../logger.js';
import { silentLogger } from '../logger.js';
import { systemClock, type Clock } from '../render/stream.js';
import type { CardAction, InteractiveConfig, InteractiveContext } from './types.js';
import { describeScope, isEventScope, logPrefix } from './types.js';
import { createApprovalAnswerer } from './approval.js';
import { PendingRegistry } from './pending.js';
import { createQuestionAnswerer, type QuestionItemLike } from './question.js';
import { approvalTerminalCard, questionCard, questionTerminalCard } from './cards.js';
import type { FeishuCard } from '../transport/types.js';

export interface InteractiveRuntimeOptions {
  readonly config: InteractiveConfig;
  readonly logger?: LoggerLike;
  readonly clock?: Clock;
  sendCard(
    sessionId: string,
    card: FeishuCard,
  ): Promise<{ readonly messageId: string; readonly threadId?: string }>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
  /** Button callback for the permission card (`caduceus.permission.switch`). */
  permissionSwitch?(action: CardAction, name: string): void | Promise<void>;
  /** Button callback for the process-card stop button. */
  turnStop?(action: CardAction): void | Promise<void>;
}

export class InteractiveRuntime {
  readonly config: InteractiveConfig;
  readonly logger: LoggerLike;
  readonly clock: Clock;
  readonly pending = new PendingRegistry();
  readonly #sendCard: InteractiveRuntimeOptions['sendCard'];
  readonly #updateCard: InteractiveRuntimeOptions['updateCard'];
  readonly #permissionSwitch: InteractiveRuntimeOptions['permissionSwitch'];
  readonly #turnStop: InteractiveRuntimeOptions['turnStop'];

  constructor(options: InteractiveRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger ?? silentLogger();
    this.clock = options.clock ?? systemClock;
    this.#sendCard = options.sendCard;
    this.#updateCard = options.updateCard;
    this.#permissionSwitch = options.permissionSwitch;
    this.#turnStop = options.turnStop;
  }

  /**
   * Register both waterfall answerers ONCE on the plugin root context, as dsh's
   * own ACP bridge does. Ownership is decided per request from
   * `request.agent.session.id`; requests for other agents are delegated by
   * calling `next()`, never claimed.
   */
  registerRoot(
    rootCtx: unknown,
    resolve: {
      ownsSession(sessionId: string): boolean;
      contextFor(sessionId: string): InteractiveContext | undefined;
    },
  ): boolean {
    if (!isEventScope(rootCtx)) {
      this.logger.warn(
        `interactive: register skipped (not an event scope: ${describeScope(rootCtx)})`,
      );
      return false;
    }
    rootCtx.on('approval/request', async (request: unknown, next: () => Promise<unknown>) => {
      const sessionId = sessionIdOf(request);
      if (sessionId === undefined || !resolve.ownsSession(sessionId)) {
        this.logger.info(
          `interactive: approval request agent=${sessionId === undefined ? '?' : logPrefix(sessionId)} not ours, delegated`,
        );
        return next();
      }
      this.logger.info(
        `interactive: approval request agent=${logPrefix(sessionId)} claimed`,
      );
      const context = resolve.contextFor(sessionId);
      return createApprovalAnswerer(this.#host(), () => context)(
        request as Parameters<ReturnType<typeof createApprovalAnswerer>>[0],
        next as () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
      );
    });
    rootCtx.on('user-questions/request', async (request: unknown, next: () => Promise<unknown>) => {
      const sessionId = sessionIdOf(request);
      if (sessionId === undefined || !resolve.ownsSession(sessionId)) {
        this.logger.info(
          `interactive: question request agent=${sessionId === undefined ? '?' : logPrefix(sessionId)} not ours, delegated`,
        );
        return next();
      }
      this.logger.info(
        `interactive: question request agent=${logPrefix(sessionId)} claimed`,
      );
      const context = resolve.contextFor(sessionId);
      return createQuestionAnswerer(this.#host(), () => context)(
        request as Parameters<ReturnType<typeof createQuestionAnswerer>>[0],
        next as () => Promise<{ answers: { id: string; selected: string[] }[] }>,
      );
    });
    this.logger.info('interactive: answerers registered (root scope)');
    return true;
  }

  /**
   * Route one card click. Unknown ids are ignored; non-owners are ignored with
   * a warning and do not resolve or patch anything.
   */
  async handleCardAction(action: CardAction): Promise<void> {
    if (action.value['action'] === 'caduceus.turn.stop') {
      this.logger.info(`card action stop operator=${logPrefix(action.operatorOpenId)}`);
      await this.#turnStop?.(action);
      return;
    }
    if (
      action.value['action'] === 'caduceus.permission.switch' &&
      typeof action.value['name'] === 'string'
    ) {
      this.logger.info(
        `card action permission switch name=${action.value['name']} operator=${logPrefix(action.operatorOpenId)}`,
      );
      await this.#permissionSwitch?.(action, action.value['name']);
      return;
    }
    const id = typeof action.value['id'] === 'string' ? action.value['id'] : undefined;
    if (id === undefined) {
      this.logger.info('card action ignored (unknown id)');
      return;
    }
    this.logger.info(
      `card action id=${id} kind=${String(action.value['kind'] ?? '?')} operator=${logPrefix(action.operatorOpenId)}`,
    );
    const entry = this.pending.get(id);
    if (entry === undefined) {
      this.logger.info('card action ignored (unknown id)');
      return;
    }
    if (action.operatorOpenId !== entry.ownerOpenId) {
      this.logger.warn(
        `ignored card action from non-owner ${action.operatorOpenId} for ${entry.kind} ${id}`,
      );
      return;
    }
    if (entry.kind === 'question' && (action.formValue !== undefined || action.value['form'] === true)) {
      const questions = entry.meta?.['questions'] as readonly QuestionItemLike[] | undefined;
      const question = questions?.[0]?.question ?? '问题';
      const questionId =
        typeof action.value['questionId'] === 'string'
          ? action.value['questionId']
          : (questions?.[0]?.id ?? '');
      const custom = (action.formValue?.['other'] ?? '').trim();
      if (custom.length === 0) {
        // Keep the pending entry and its timer: prompt again on the same card.
        const rebuilt = questionCard({
          requestId: entry.id,
          sessionId: entry.sessionId,
          ...(questions === undefined ? { questions: [] } : { questions }),
          hint: '请填写后再提交',
        });
        await this.#patchTerminal(entry, rebuilt.card);
        return;
      }
      this.pending.delete(id);
      await this.#patchTerminal(entry, questionTerminalCard(question, `已填写：${custom.slice(0, 40)}`));
      entry.resolve({ answers: [{ id: questionId, selected: [], custom }] });
      return;
    }

    this.pending.delete(id);

    if (entry.kind === 'approval') {
      const choice = action.value['choice'] === 'allow' ? 'allow' : 'reject';
      const outcome = choice === 'allow' ? 'allowed-once' : 'rejected';
      await this.#patchTerminal(entry, approvalTerminalCard(
        String(entry.meta?.['toolName'] ?? 'tool'),
        outcome === 'allowed-once' ? '已允许' : '已拒绝',
      ));
      entry.resolve(outcome);
      return;
    }

    const label = typeof action.value['label'] === 'string' ? action.value['label'] : '';
    const questionId = typeof action.value['questionId'] === 'string' ? action.value['questionId'] : '';
    const question = (entry.meta?.['questions'] as readonly { readonly question?: string }[] | undefined)?.[0]
      ?.question ?? '问题';
    await this.#patchTerminal(entry, questionTerminalCard(question, `已选择：${label}`));
    entry.resolve({ answers: [{ id: questionId, selected: [label] }] });
  }

  async #patchTerminal(
    entry: { readonly cardMessageId?: string },
    card: FeishuCard,
  ): Promise<void> {
    if (entry.cardMessageId === undefined) return;
    try {
      await this.#updateCard(entry.cardMessageId, card);
    } catch (error) {
      this.logger.warn(
        `interactive card patch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #host(): {
    config: InteractiveConfig;
    logger: LoggerLike;
    clock: Clock;
    pending: PendingRegistry;
    sendCard(
      sessionId: string,
      card: FeishuCard,
    ): Promise<{ readonly messageId: string; readonly threadId?: string }>;
    updateCard(messageId: string, card: FeishuCard): Promise<void>;
  } {
    return {
      config: this.config,
      logger: this.logger,
      clock: this.clock,
      pending: this.pending,
      sendCard: (sessionId, card) => this.#sendCard(sessionId, card),
      updateCard: (messageId, card) => this.#updateCard(messageId, card),
    };
  }
}

/** Extract `request.agent.session.id` structurally (dsh waterfall payloads). */
function sessionIdOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const agent = (request as { agent?: unknown }).agent;
  if (typeof agent !== 'object' || agent === null) return undefined;
  const session = (agent as { session?: unknown }).session;
  if (typeof session !== 'object' || session === null) return undefined;
  const id = (session as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
