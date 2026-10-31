/**
 * Feishu v1 interactive-card builders used by the surface.
 *
 * Every card produced here declares `config.update_multi = true`, which Feishu
 * requires for in-place patches (design doc §14 ⑪). Long text is truncated
 * through the slice-1 helper so a card never approaches the 30 KB payload cap.
 *
 * @module @artomyuan/dsh-caduceus/render/cards
 */
import type { FeishuCard, FeishuCardElement } from '../transport/types.js';
import { CARD_CONTENT_LIMIT_BYTES, CARD_TAIL_BYTES, truncateCardContent } from './truncate.js';

/** Feishu's card-payload ceiling, re-exported for tests/lint. */
export const CARD_BYTE_LIMIT = CARD_CONTENT_LIMIT_BYTES;

/** Size of a serialized card in UTF-8 bytes. */
export function cardByteSize(card: FeishuCard): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

/** Throw when a card would exceed Feishu's payload cap. */
export function assertCardFits(card: FeishuCard): void {
  const bytes = cardByteSize(card);
  if (bytes > CARD_BYTE_LIMIT) {
    throw new RangeError(`feishu card is ${bytes} bytes; the platform limit is ${CARD_BYTE_LIMIT}`);
  }
}

function div(content: string, markdown = true): FeishuCardElement {
  return {
    tag: 'div',
    text: { tag: markdown ? 'lark_md' : 'plain_text', content },
  };
}

export interface CardInput {
  readonly title: string;
  /** Header template colour (`blue` / `green` / `red` / `grey` / `orange`). */
  readonly template?: string;
  readonly elements: readonly FeishuCardElement[];
}

/** Build a card with the mandatory update flag and a header. */
export function buildCard(input: CardInput): FeishuCard {
  const card: FeishuCard = {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: input.title },
      ...(input.template === undefined ? {} : { template: input.template }),
    },
    elements: input.elements,
  };
  assertCardFits(card);
  return card;
}

/** Truncate a tail into the per-card text budget (UTF-8 safe). */
export function tailText(text: string, maxBytes = CARD_TAIL_BYTES): string {
  const result = truncateCardContent(text, { maxBytes });
  return result.text;
}

export interface ProgressCardInput {
  readonly title: string;
  readonly stateLabel: string;
  readonly steps: number;
  readonly tools: number;
  /** Unix epoch ms when the turn started; used for the elapsed line. */
  readonly startedAt?: number;
  readonly now?: number;
  /** Latest assistant output tail. */
  readonly tail?: string;
}

/** The per-turn "process" card: state line plus the tail of the output. */
export function progressCard(input: ProgressCardInput): FeishuCard {
  const stateLine = [`**${input.stateLabel}**`, `步数 ${input.steps}`, `工具 ${input.tools}`];
  if (input.startedAt !== undefined) {
    const now = input.now ?? Date.now();
    const seconds = Math.max(0, Math.floor((now - input.startedAt) / 1000));
    stateLine.push(`已运行 ${seconds}s`);
  }
  const elements: FeishuCardElement[] = [div(stateLine.join(' · '))];
  const tail = input.tail === undefined ? '' : tailText(input.tail);
  if (tail.trim().length > 0) elements.push(div(tail));
  elements.push(div('_过程消息；收尾会另发一条终稿。_'));
  return buildCard({ title: input.title, template: 'blue', elements });
}

export interface StatusCardInput {
  readonly title: string;
  /** Rendered status lines (state, steps, timing, last event). */
  readonly lines: readonly string[];
  readonly template?: string;
}

/** The per-scope "current status" card (design doc §6 L3′). */
export function statusCard(input: StatusCardInput): FeishuCard {
  const elements = input.lines.map((line) => div(line));
  return buildCard({
    title: input.title,
    template: input.template ?? 'grey',
    elements,
  });
}

/** A standalone markdown card (used for help/status replies rendered as cards). */
export function markdownCard(title: string, markdown: string, template = 'grey'): FeishuCard {
  return buildCard({ title, template, elements: [div(tailText(markdown))] });
}
