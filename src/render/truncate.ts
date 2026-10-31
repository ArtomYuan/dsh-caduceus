/**
 * Card rendering helpers: truncate streamed/tool content to the tail.
 *
 * A Feishu card patch may hold at most 30 KB and is patched many times per
 * turn, so the surface keeps only the tail (~8 KB) of long content and prepends
 * one short note saying how much was dropped (design doc §6 L3).
 *
 * Byte-based, never character-based: the cut point must not split a multi-byte
 * UTF-8 sequence (Chinese, emoji, …). This module is pure — no I/O, no clock.
 *
 * @module @artomyuan/dsh-caduceus/render/truncate
 */
import { Buffer } from 'node:buffer';

/** Hard Feishu card-patch payload ceiling (design doc §12 risk 2). */
export const CARD_CONTENT_LIMIT_BYTES = 30 * 1024;

/** Default tail budget kept from the end of long content. */
export const CARD_TAIL_BYTES = 8 * 1024;

export interface TruncateOptions {
  /** Tail budget in UTF-8 bytes; defaults to `CARD_TAIL_BYTES`. Must be a positive safe integer. */
  readonly maxBytes?: number;
  /** Builds the omitted-content note; defaults to `（已省略 N 字符）`. */
  readonly note?: (omittedChars: number, omittedBytes: number) => string;
}

export interface TruncateResult {
  /** The text to put in the card: note + kept tail. */
  readonly text: string;
  readonly truncated: boolean;
  /** UTF-8 bytes of the kept tail (≤ `maxBytes`). */
  readonly keptBytes: number;
  /** UTF-8 bytes dropped from the head. */
  readonly omittedBytes: number;
  /** Unicode code points dropped from the head. */
  readonly omittedChars: number;
}

const defaultNote = (omittedChars: number): string => `（已省略 ${omittedChars} 字符）\n\n`;

/**
 * Keep the UTF-8-safe tail of `input` within `maxBytes`, prefixing a note.
 *
 * Content already within budget is returned byte-identical (`truncated:false`).
 * The kept part is always a suffix of the original, cut on code-point
 * boundaries, and `omittedChars` counts code points (not UTF-16 units), so
 * surrogate pairs are dropped whole.
 */
export function truncateCardContent(input: string, options: TruncateOptions = {}): TruncateResult {
  const maxBytes = options.maxBytes ?? CARD_TAIL_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`maxBytes must be a positive safe integer, got ${String(maxBytes)}`);
  }

  const totalBytes = Buffer.byteLength(input, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text: input, truncated: false, keptBytes: totalBytes, omittedBytes: 0, omittedChars: 0 };
  }

  const codePoints = Array.from(input);
  let keptBytes = 0;
  let keepFrom = codePoints.length;
  while (keepFrom > 0) {
    const codePoint = codePoints[keepFrom - 1] as string;
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (keptBytes + bytes > maxBytes) break;
    keptBytes += bytes;
    keepFrom -= 1;
  }

  const tail = codePoints.slice(keepFrom).join('');
  const omittedChars = keepFrom;
  const omittedBytes = totalBytes - keptBytes;
  const note = (options.note ?? defaultNote)(omittedChars, omittedBytes);
  return { text: note + tail, truncated: true, keptBytes, omittedBytes, omittedChars };
}
