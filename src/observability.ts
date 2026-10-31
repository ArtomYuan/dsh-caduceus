/**
 * Operator-visible one-line summaries: startup, session scope, command lines.
 *
 * The startup line must never leak any part of `appSecret`; it is accepted as
 * an input only so tests can assert it is absent from the output.
 *
 * @module @artomyuan/dsh-caduceus/observability
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

/** `scope: kind=topic key=oc_x\0omt_yz session=feishu-a` */
export function formatScopeLine(
  chatType: ChatType,
  key: string,
  sessionId: string,
  groupSessionsPerUser: boolean,
): string {
  const kind = scopeKind(chatType, key, groupSessionsPerUser);
  const keyPrefix = key.slice(0, 16).replace(/\u0000/g, '\\0');
  return `scope: kind=${kind} key=${keyPrefix} session=${sessionId.slice(0, 8)}`;
}
