/**
 * Operator-visible one-line summaries: startup, session scope, command lines.
 *
 * The startup line must never leak any part of `appSecret`; it is accepted as
 * an input only so tests can assert it is absent from the output.
 *
 * @module dsh-caduceus/observability
 */
import type { BusyMode } from './bridge/types.js';
import type { ChatType } from './transport/types.js';

export interface StartupLineInput {
  readonly appId?: string;
  /** Never printed; accepted so tests can prove no fragment leaks. */
  readonly appSecret?: string;
  readonly defaultCwd: string;
  readonly groupSessionsPerUser: boolean;
  readonly cardThrottleMs: number;
  readonly busyMode: BusyMode;
}

/** Show only a short appId prefix + the last 4 characters. */
export function maskAppId(appId: string | undefined): string {
  if (appId === undefined || appId.length === 0) return '(missing)';
  if (appId.length <= 8) return appId;
  return `${appId.slice(0, 7)}…${appId.slice(-4)}`;
}

/** `ready appId=cli_xxx…abcd defaultCwd=… groupSessionsPerUser=… throttle=… busyMode=…` */
export function formatStartupLine(input: StartupLineInput): string {
  return [
    `ready appId=${maskAppId(input.appId)}`,
    `defaultCwd=${input.defaultCwd}`,
    `groupSessionsPerUser=${input.groupSessionsPerUser}`,
    `throttle=${input.cardThrottleMs}`,
    `busyMode=${input.busyMode}`,
  ].join(' ');
}

/** Session-key kind for the `scope:` line. */
export type ScopeKind = 'p2p' | 'topic' | 'group-user' | 'group-shared';

export function scopeKind(
  chatType: ChatType,
  key: string,
  groupSessionsPerUser: boolean,
): ScopeKind {
  if (chatType === 'p2p') return 'p2p';
  const separatorAt = key.indexOf('\u0000');
  const suffix = separatorAt === -1 ? undefined : key.slice(separatorAt + 1);
  if (suffix !== undefined && suffix.startsWith('omt_')) return 'topic';
  if (suffix !== undefined && suffix.startsWith('ou_')) return 'group-user';
  if (!groupSessionsPerUser) return 'group-shared';
  return 'group-shared';
}

/** Display form of a session id: its last 8 characters (ids are `feishu-<epoch-ms>`). */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(-8);
}

/**
 * Parse the epoch-ms out of `feishu-<epoch-ms>`. Returns `undefined` for ids
 * that do not follow the minted format (e.g. legacy/foreign ids), so callers
 * can fall back to event times or `—`.
 */
export function sessionIdTimestamp(sessionId: string): number | undefined {
  const match = /^feishu-(\d{10,})$/u.exec(sessionId);
  if (match === null) return undefined;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) return undefined;
  // Plausible epoch-ms window: 2000-01-01 .. 2100-01-01.
  if (value < 946_684_800_000 || value > 4_102_444_800_000) return undefined;
  return value;
}

/**
 * Human time for `/sessions`: `刚刚` / `N 分钟前` / `N 小时前` /
 * `MM-DD HH:mm` (UTC). `—` when no timestamp is available.
 */
export function sessionTimeLabel(ms: number | undefined, now: number): string {
  if (ms === undefined) return '—';
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

/** `scope: kind=topic key=oc_x\0omt_yz session=<last 8>` */
export function formatScopeLine(
  chatType: ChatType,
  key: string,
  sessionId: string,
  groupSessionsPerUser: boolean,
): string {
  const kind = scopeKind(chatType, key, groupSessionsPerUser);
  const keyPrefix = key.slice(0, 16).replace(/\u0000/g, '\\0');
  return `scope: kind=${kind} key=${keyPrefix} session=${shortSessionId(sessionId)}`;
}
