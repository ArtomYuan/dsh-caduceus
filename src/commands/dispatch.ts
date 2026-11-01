/**
 * Slash-line dispatch policy: owner commands vs the dsh registry passthrough vs
 * the Web-only denylist.
 *
 * The surface owns eight commands; every other slash line is forwarded to the
 * harness command registry (`runHarnessCommand`), except Web-only commands that
 * make no sense on a chat surface. `/export` is now implemented by the surface
 * itself, so the list is intentionally empty; keep the seam for future entries.
 *
 * @module dsh-caduceus/commands/dispatch
 */
import { parseCommand, type ParsedCommand } from './parse.js';

/** Commands that exist only in the Web UI and are refused on Feishu. */
export const WEB_ONLY_DENYLIST: readonly string[] = [];

/** True when a slash-command name must not be forwarded to the harness. */
export function isWebOnlyCommand(name: string): boolean {
  return WEB_ONLY_DENYLIST.includes(name.toLowerCase());
}

/** A parsed owner command (everything except passthrough). */
export type OwnedCommand = Exclude<ParsedCommand, { readonly kind: 'passthrough' }>;

/** What the bridge should do with a slash line. */
export type SlashPlan =
  | { readonly kind: 'owned'; readonly command: OwnedCommand }
  | { readonly kind: 'denied'; readonly name: string; readonly line: string }
  | { readonly kind: 'forward'; readonly name: string; readonly line: string };

/**
 * Classify one inbound message. Non-slash text is returned as `forward` too;
 * the bridge checks `text.startsWith('/')` before calling this.
 */
export function planSlashLine(raw: string): SlashPlan {
  const parsed = parseCommand(raw);
  if (parsed.kind !== 'passthrough') return { kind: 'owned', command: parsed };

  const match = /^\/(\S+)/.exec(raw.trim());
  const name = (match?.[1] ?? '').toLowerCase();
  if (name.length > 0 && isWebOnlyCommand(name)) {
    return { kind: 'denied', name, line: raw };
  }
  return { kind: 'forward', name, line: raw };
}
