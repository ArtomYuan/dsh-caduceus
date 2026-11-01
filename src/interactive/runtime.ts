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
import { describeScope, isAgentScope, logPrefix } from './types.js';
import { createApprovalAnswerer } from './approval.js';
import { PendingRegistry } from './pending.js';
import { createQuestionAnswerer } from './question.js';
import { approvalTerminalCard, questionTerminalCard } from './cards.js';
import type { FeishuCard } from '../transport/types.js';

export interface InteractiveRuntimeOptions {
  readonly config: InteractiveConfig;
  readonly logger?: LoggerLike;
  readonly clock?: Clock;
  sendCard(chatId: string, card: FeishuCard): Promise<{ readonly messageId: string }>;
  updateCard(messageId: string, card: FeishuCard): Promise<void>;
}

export class InteractiveRuntime {
  readonly config: InteractiveConfig;
  readonly logger: LoggerLike;
  readonly clock: Clock;
  readonly pending = new PendingRegistry();
  readonly #sendCard: InteractiveRuntimeOptions['sendCard'];
  readonly #updateCard: InteractiveRuntimeOptions['updateCard'];
  #attached = 0;

  constructor(options: InteractiveRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger ?? silentLogger();
    this.clock = options.clock ?? systemClock;
    this.#sendCard = options.sendCard;
    this.#updateCard = options.updateCard;
  }

  /** Install the two waterfall answerers on one agent scope. */
  attach(agentCtx: unknown, contextFor: () => InteractiveContext | undefined): boolean {
    if (!isAgentScope(agentCtx)) {
      this.logger.warn(
        `interactive: attach skipped (not an agent scope: ${describeScope(agentCtx)})`,
      );
      return false;
    }
    agentCtx.on('approval/request', (request: unknown, next: () => Promise<unknown>) =>
      createApprovalAnswerer(this.#host(), contextFor)(
        request as Parameters<ReturnType<typeof createApprovalAnswerer>>[0],
        next as () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
      ),
    );
    agentCtx.on('user-questions/request', (request: unknown) =>
      createQuestionAnswerer(this.#host(), contextFor)(
        request as Parameters<ReturnType<typeof createQuestionAnswerer>>[0],
        async () => ({ answers: [] }),
      ),
    );
    this.#attached += 1;
    this.logger.info(`interactive: attached to agent scope (total=${this.#attached})`);
    return true;
  }

  /** Number of agent scopes the answerers were attached to (diagnostics/tests). */
  get attachedCount(): number {
    return this.#attached;
  }

  /**
   * Route one card click. Unknown ids are ignored; non-owners are ignored with
   * a warning and do not resolve or patch anything.
   */
  async handleCardAction(action: CardAction): Promise<void> {
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
    sendCard(chatId: string, card: FeishuCard): Promise<{ readonly messageId: string }>;
    updateCard(messageId: string, card: FeishuCard): Promise<void>;
  } {
    return {
      config: this.config,
      logger: this.logger,
      clock: this.clock,
      pending: this.pending,
      sendCard: (chatId, card) => this.#sendCard(chatId, card),
      updateCard: (messageId, card) => this.#updateCard(messageId, card),
    };
  }
}
