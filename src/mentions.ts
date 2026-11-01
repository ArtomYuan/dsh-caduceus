/**
 * Leading Feishu mention stripping.
 *
 * Feishu renders @-mentions in message text either as `<at ...>...</at>` tags
 * (already removed by the transport normalizer) or as placeholders such as
 * `@_user_1` / `@_user_2`. Only mentions at the START of a message are removed:
 * a `/command` typed after them must still be recognized, while ordinary text
 * keeps its original form (mentions inside the body stay untouched).
 *
 * @module dsh-caduceus/mentions
 */

/** One or more leading `@mention` tokens followed by optional whitespace. */
const LEADING_MENTIONS = /^\s*(?:@\S+\s*)+/;

/** Strip only the leading mention prefix; body mentions are preserved. */
export function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS, '');
}

/** True when the text begins with one or more mentions. */
export function hasLeadingMentions(text: string): boolean {
  return LEADING_MENTIONS.test(text);
}
