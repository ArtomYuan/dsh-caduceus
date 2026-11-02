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

/** Card from pre-built elements (forms, inputs, action rows). */
export function interactiveElementsCard(
  title: string,
  elements: readonly FeishuCardElement[],
  template = 'orange',
): FeishuCard {
  return buildCard({ title, template, elements });
}

export function approvalCard(
  requestId: string,
  sessionId: string,
  toolName: string,
  reason: string | undefined,
  permissionLine?: string,
): FeishuCard {
  return interactiveCard(`审批请求 · ${toolName}`, [
    ...(permissionLine === undefined ? [] : [permissionLine]),
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
  /** Extra warning appended to the card (e.g. the empty-custom hint). */
  readonly hint?: string;
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
    if (question.multiSelect === true) lines.push('_（多选暂不支持，仅能选一项）_');
    for (const option of question.options ?? []) {
      lines.push(`- ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`);
    }
  }
  if (input.hint !== undefined && input.hint.length > 0) lines.push(`**${input.hint}**`);
  const only = questions.length === 1 ? questions[0] : undefined;
  const options = only?.options ?? [];
  const buttons =
    only !== undefined &&
    options.length > 0 &&
    options.length <= 4;
  const elements: FeishuCardElement[] = lines.map(div);
  if (buttons) {
    elements.push(
      actionRow(
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
    );
  }

  if (only === undefined) {
    lines.push('_本版暂不支持在卡片内输入文字，请直接回复文本作答。_');
    return { card: interactiveCard('问题', lines), buttons: false };
  }

  elements.push(div('或自己填：'));
  elements.push({
    tag: 'form',
    name: 'question_form',
    elements: [
      {
        tag: 'input',
        name: 'other',
        placeholder: { tag: 'plain_text', content: '输入自定义答案' },
        max_length: 200,
      },
      {
        tag: 'button',
        name: 'submit',
        type: 'primary',
        action_type: 'form_submit',
        text: { tag: 'plain_text', content: '提交' },
        value: {
          kind: 'question',
          id: input.requestId,
          sessionId: input.sessionId,
          questionId: only.id,
          form: true,
        },
      },
    ],
  });
  const title = only.header === undefined ? `问题 · ${only.question}` : `问题 · ${only.header}`;
  return {
    card: interactiveElementsCard(title, elements),
    buttons,
  };
}

export function questionTerminalCard(question: string, answer: string): FeishuCard {
  return interactiveCard(`问题 · ${question}`, [answer], [], 'grey');
}
