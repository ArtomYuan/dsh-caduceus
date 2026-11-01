/**
 * Interactive Feishu card builders (approval / question / terminal states).
 *
 * @module dsh-caduceus/interactive/cards
 */
import { buildCard } from '../render/cards.js';
import type { FeishuCard, FeishuCardElement } from '../transport/types.js';

export interface CardButton {
  readonly label: string;
  readonly type?: 'primary' | 'danger' | 'default';
  readonly value: Record<string, unknown>;
}

function div(content: string): FeishuCardElement {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actionRow(buttons: readonly CardButton[]): FeishuCardElement {
  return {
    tag: 'action',
    actions: buttons.map((button) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: button.label },
      type: button.type ?? 'default',
      value: button.value,
    })),
  };
}

/** A card with optional buttons. */
export function interactiveCard(
  title: string,
  lines: readonly string[],
  buttons: readonly CardButton[] = [],
  template = 'orange',
): FeishuCard {
  const elements: FeishuCardElement[] = lines.map(div);
  if (buttons.length > 0) elements.push(actionRow(buttons));
  return buildCard({ title, template, elements });
}

export function approvalCard(
  requestId: string,
  sessionId: string,
  toolName: string,
  reason: string | undefined,
): FeishuCard {
  return interactiveCard(`审批请求 · ${toolName}`, [
    reason === undefined || reason.trim().length === 0 ? '（无说明）' : reason,
  ], [
    {
      label: '允许一次',
      type: 'primary',
      value: { kind: 'approval', id: requestId, sessionId, choice: 'allow' },
    },
    {
      label: '拒绝',
      type: 'danger',
      value: { kind: 'approval', id: requestId, sessionId, choice: 'reject' },
    },
  ]);
}

export function approvalTerminalCard(toolName: string, outcome: string): FeishuCard {
  return interactiveCard(`审批请求 · ${toolName}`, [outcome], [], 'grey');
}

export interface QuestionCardInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly header?: string;
    readonly detail?: string;
    readonly options?: readonly { readonly label: string; readonly description?: string }[];
    readonly multiSelect?: boolean;
  }[];
}

export interface QuestionCardResult {
  readonly card: FeishuCard;
  readonly buttons: boolean;
}

/** Buttons only for exactly one single-select question with 1..4 options. */
export function questionCard(input: QuestionCardInput): QuestionCardResult {
  const questions = input.questions;
  const lines: string[] = [];
  for (const question of questions) {
    const heading = question.header === undefined ? question.question : `${question.header}：${question.question}`;
    lines.push(`**${heading}**`);
    if (question.detail !== undefined && question.detail.trim().length > 0) lines.push(question.detail);
    for (const option of question.options ?? []) {
      lines.push(`- ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`);
    }
  }
  const only = questions.length === 1 ? questions[0] : undefined;
  const options = only?.options ?? [];
  const buttons =
    only !== undefined &&
    only.multiSelect !== true &&
    options.length > 0 &&
    options.length <= 4;
  if (!buttons) {
    lines.push('_本版暂不支持在卡片内输入文字，请直接回复文本作答。_');
    return { card: interactiveCard('问题', lines), buttons: false };
  }
  const title = only.header === undefined ? `问题 · ${only.question}` : `问题 · ${only.header}`;
  return {
    card: interactiveCard(
      title,
      lines,
      options.map((option) => ({
        label: option.label,
        value: {
          kind: 'question',
          id: input.requestId,
          sessionId: input.sessionId,
          questionId: only.id,
          label: option.label,
        },
      })),
    ),
    buttons: true,
  };
}

export function questionTerminalCard(question: string, answer: string): FeishuCard {
  return interactiveCard(`问题 · ${question}`, [answer], [], 'grey');
}
