/**
 * Render public surface.
 * @module @artomyuan/dsh-caduceus/render
 */
export { CardStream, systemClock } from './stream.js';
export type { CardChannel, CardStreamOptions, Clock, TimerHandle } from './stream.js';
export {
  CARD_BYTE_LIMIT,
  assertCardFits,
  buildCard,
  cardByteSize,
  markdownCard,
  finalCard,
  finalCardPlainText,
  progressCard,
  statusCard,
  tailText,
} from './cards.js';
export type { CardInput, FinalCardInput, ProgressCardInput, StatusCardInput } from './cards.js';
export { CARD_CONTENT_LIMIT_BYTES, CARD_TAIL_BYTES, truncateCardContent } from './truncate.js';
export type { TruncateOptions, TruncateResult } from './truncate.js';
