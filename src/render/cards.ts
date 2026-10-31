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
  /** Session title shown on the state line when known. */
  readonly sessionTitle?: string;
  /** Latest tool/event label (clipped to 40 characters). */
  readonly recentEvent?: string;
  /** Assistant output tail shown while the turn runs (≤8 KB). */
  readonly tail?: string;
}

/** Clip by Unicode code point so a label never exceeds the budget. */
export function clipLabel(text: string, maxChars = 40): string {
  return Array.from(text).slice(0, maxChars).join('');
}

/**
 * The single per-turn card: state line (title/state/steps/tools/elapsed) and a
 * one-line recent event. It deliberately carries NO assistant body — the final
 * message is the only place an answer is rendered, so a short answer can never
 * appear twice.
 */
export function progressCard(input: ProgressCardInput): FeishuCard {
  const stateLine: string[] = [];
  const sessionTitle = input.sessionTitle?.trim();
  if (sessionTitle !== undefined && sessionTitle.length > 0) {
    stateLine.push(`会话：${clipLabel(sessionTitle)}`);
  }
  stateLine.push(`**${input.stateLabel}**`, `步数 ${input.steps}`, `工具 ${input.tools}`);
  if (input.startedAt !== undefined) {
    const now = input.now ?? Date.now();
    const seconds = Math.max(0, Math.floor((now - input.startedAt) / 1000));
    stateLine.push(`已运行 ${seconds}s`);
  }
  const elements: FeishuCardElement[] = [
    div(stateLine.join(' · ')),
    div(`最近：${clipLabel(input.recentEvent ?? '（无）')}`),
  ];
  const tail = input.tail === undefined ? '' : tailText(input.tail);
  if (tail.trim().length > 0) elements.push(div(tail));
  elements.push(div('_过程消息；收尾会把终稿更新到本卡。_'));
  return buildCard({ title: input.title, template: 'blue', elements });
}

export interface FinalCardInput {
  readonly title: string;
  readonly stateLabel: string;
  readonly steps: number;
  readonly tools: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly sessionTitle?: string;
  readonly recentEvent?: string;
  /** Complete assistant output; clipped to the card budget with a head note. */
  readonly body: string;
  readonly template?: string;
}

/** State-line parts shared by the card markdown and the text fallback. */
function finalStateLine(input: FinalCardInput, markdown: boolean): string {
  const parts: string[] = [];
  const sessionTitle = input.sessionTitle?.trim();
  if (sessionTitle !== undefined && sessionTitle.length > 0) {
    parts.push(`会话：${clipLabel(sessionTitle)}`);
  }
  parts.push(markdown ? `**${input.stateLabel}**` : input.stateLabel);
  parts.push(`步数 ${input.steps}`, `工具 ${input.tools}`);
  const end = input.endedAt ?? Date.now();
  if (input.startedAt !== undefined) {
    const seconds = Math.max(0, Math.floor((end - input.startedAt) / 1000));
    parts.push(`已运行 ${seconds}s`);
  }
  return parts.join(' · ');
}

/**
 * Final state of the one card: terminal state line plus the complete answer.
 * The answer is kept within Feishu's 30 KB payload; when clipped, the kept tail
 * is prefixed with `…已省略 N 字符` (UTF-8 safe).
 */
export function finalCard(input: FinalCardInput): FeishuCard {
  const stateElement = div(finalStateLine(input, true));
  const template = input.template ?? 'grey';
  const base = buildCard({ title: input.title, template, elements: [stateElement] });
  const note = (omittedChars: number): string => `…已省略 ${omittedChars} 字符\n\n`;
  // Reserve the state line + JSON envelope; retry smaller if the payload is
  // still too large (cardByteSize includes escaping, which varies by content).
  let budget = Math.max(1, CARD_CONTENT_LIMIT_BYTES - cardByteSize(base) - 1024);
  let body = truncateCardContent(input.body, { maxBytes: budget, note });
  let card = buildCard({
    title: input.title,
    template,
    elements: [stateElement, div(body.text)],
  });
  while (cardByteSize(card) > CARD_CONTENT_LIMIT_BYTES && budget > 1) {
    budget = Math.max(1, Math.floor(budget * 0.75));
    body = truncateCardContent(input.body, { maxBytes: budget, note });
    card = buildCard({
      title: input.title,
      template,
      elements: [stateElement, div(body.text)],
    });
  }
  return card;
}

/** Plain-text equivalent of the final card, used only for the fallback path. */
export function finalCardPlainText(input: FinalCardInput): string {
  return `${finalStateLine(input, false)}\n\n${input.body}`;
}

export interface StatusCardInput {
  readonly title: string;
  /** Rendered status lines (state, steps, timing, last event). */
  readonly lines: readonly string[];
  readonly template?: string;
}

/** Legacy standalone status card (no longer sent; the process card is merged). */
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
