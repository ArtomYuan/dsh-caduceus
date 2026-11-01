/**
 * `user-questions/request` answerer: render one question card (buttons when a
 * single question has 1..4 options) and resolve the first click. Free-text
 * answers are not implemented in this version; text-only cards expire.
 *
 * @module dsh-caduceus/interactive/question
 */
import { questionCard, questionTerminalCard } from './cards.js';
import { logPrefix, type InteractiveContext, type InteractiveHost } from './types.js';

export interface QuestionItemLike {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly detail?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
}

export interface QuestionRequestLike {
  readonly questions: readonly QuestionItemLike[];
  readonly signal?: AbortSignal;
}

export interface QuestionAnswerLike {
  readonly answers: readonly {
    readonly id: string;
    readonly selected: readonly string[];
    readonly custom?: string;
  }[];
}

export type QuestionAnswerer = (
  request: QuestionRequestLike,
  next: () => Promise<QuestionAnswerLike>,
) => Promise<QuestionAnswerLike>;

export function createQuestionAnswerer(
  host: InteractiveHost,
  contextFor: () => InteractiveContext | undefined,
): QuestionAnswerer {
  return async (request) => {
    if (!host.config.questionCard) {
      host.logger.warn('interactive: question skipped (questionCard disabled)');
      throw new Error('interactive question cards are disabled');
    }
    const context = contextFor();
    if (context === undefined) {
      host.logger.warn('interactive: question skipped (no session context)');
      throw new Error('no caduceus session context for user question');
    }

    let settle!: (answer: QuestionAnswerLike) => void;
    let fail!: (error: unknown) => void;
    const answer = new Promise<QuestionAnswerLike>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const entry = host.pending.add({
      kind: 'question',
      scopeKey: context.scopeKey,
      chatId: context.chatId,
      ownerOpenId: context.ownerOpenId,
      sessionId: context.sessionId,
      createdAt: host.clock.now(),
      resolve: (value) => settle(value as QuestionAnswerLike),
      reject: (error) => fail(error),
      meta: { questions: request.questions },
    });
    host.logger.info(
      `interactive: question request id=${entry.id} questions=${request.questions.length} scope=${context.scopeKey}`,
    );
    const rendered = questionCard({
      requestId: entry.id,
      sessionId: context.sessionId,
      questions: request.questions,
    });

    let timer: unknown;
    const onAbort = (): void => {
      if (host.pending.delete(entry.id) === undefined) return;
      void host
        .updateCard(
          entry.cardMessageId ?? '',
          questionTerminalCard(request.questions[0]?.question ?? '问题', '已取消'),
        )
        .catch(() => undefined);
      fail(new Error('user question cancelled'));
    };
    const cleanup = (): void => {
      if (timer !== undefined) host.clock.clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    };
    entry.cleanup = cleanup;

    host.logger.info(`interactive: question card sending chat=${logPrefix(context.chatId)}`);
    try {
      entry.cardMessageId = (await host.sendCard(context.chatId, rendered.card)).messageId;
      host.logger.info(
        `interactive: question card sent messageId=${logPrefix(entry.cardMessageId)}`,
      );
    } catch (error) {
      host.pending.delete(entry.id);
      host.logger.error(
        `interactive: question card send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error instanceof Error ? error : new Error(String(error));
    }

    timer = host.clock.setTimeout(() => {
      if (host.pending.delete(entry.id) === undefined) return;
      host.logger.info(
        `interactive: question timed out after ${host.config.timeoutMs}ms`,
      );
      void host
        .updateCard(
          entry.cardMessageId ?? '',
          questionTerminalCard(request.questions[0]?.question ?? '问题', '已过期'),
        )
        .catch(() => undefined);
      fail(new Error('user question timed out'));
    }, host.config.timeoutMs);

    if (request.signal?.aborted === true) {
      onAbort();
      return answer;
    }
    request.signal?.addEventListener('abort', onAbort, { once: true });
    return answer;
  };
}
