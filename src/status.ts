/**
 * Session status layer (design doc §6 L3′).
 *
 * Everything here is derived from the four existing boundary events:
 * `turn/start`, `step/start`, `step/end`, `turn/end` (whose payload carries a
 * `reason.kind`). No extra data source is invented.
 *
 * Mapping:
 * - no turn yet → 等待输入 (`waiting-input`)
 * - inside a turn → 运行中 (`running`), steps counted from `step/start`
 * - `turn/end completed` → 完成 (`completed`)
 * - `turn/end error` → 失败 (`failed`) with the provider message
 * - `turn/end blocked` → 待审批 (`waiting-approval`)
 * - `turn/end aborted / interrupted` → 已中断 (`interrupted`)
 * - `turn/end max-tokens` → 失败（需要续写）(`failed`)
 *
 * The three "user must know without asking" reasons are `error`,
 * `interrupted` and `blocked` (design doc §6 L3′ terminal push).
 *
 * @module @artomyuan/dsh-caduceus/status
 */

/** Derived session states. */
export type StatusState =
  | 'waiting-input'
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting-approval'
  | 'interrupted';

/** Immutable status snapshot. */
export interface StatusSnapshot {
  readonly state: StatusState;
  /** Steps entered this turn (`step/start` count). */
  readonly steps: number;
  /** Tool calls seen this turn (`tool/call` count). */
  readonly tools: number;
  /** Latest turn number. */
  readonly turn: number;
  /** Unix epoch ms of `turn/start`. */
  readonly startedAt?: number;
  /** Unix epoch ms of `turn/end`. */
  readonly endedAt?: number;
  /** Unix epoch ms of the latest event. */
  readonly lastEventAt?: number;
  readonly lastEventType?: string;
  /** The raw `turn/end` reason kind, when the latest turn ended. */
  readonly terminalKind?: string;
  /** Provider failure text for `turn/end error`. */
  readonly errorMessage?: string;
}

/** Structural subset of a dsh `SessionEvent` used by the reducer. */
export interface StatusEventLike {
  readonly type: string;
  readonly time?: number;
  readonly data?: unknown;
}

interface TurnEndData {
  readonly turn?: number;
  readonly reason?: {
    readonly kind?: string;
    readonly error?: {
      readonly message?: string;
    };
  };
}

interface TurnBoundaryData {
  readonly turn?: number;
}

const INITIAL: StatusSnapshot = { state: 'waiting-input', steps: 0, tools: 0, turn: 0 };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Reduce the status from one session event. */
export class StatusTracker {
  private snapshot: StatusSnapshot = INITIAL;

  /** Apply one event and return the new snapshot. */
  apply(event: StatusEventLike): StatusSnapshot {
    const time = event.time;
    const data = asRecord(event.data);
    const base = this.snapshot;
    const common = {
      ...(time === undefined ? {} : { lastEventAt: time }),
      lastEventType: event.type,
    };

    switch (event.type) {
      case 'turn/start': {
        const turn = typeof data?.['turn'] === 'number' ? (data['turn'] as number) : base.turn + 1;
        this.snapshot = {
          state: 'running',
          steps: 0,
          tools: 0,
          turn,
          ...(time === undefined ? {} : { startedAt: time }),
          ...common,
        };
        return this.snapshot;
      }
      case 'step/start': {
        this.snapshot = { ...base, state: 'running', steps: base.steps + 1, ...common };
        return this.snapshot;
      }
      case 'step/end': {
        this.snapshot = { ...base, state: 'running', ...common };
        return this.snapshot;
      }
      case 'tool/call': {
        this.snapshot = { ...base, tools: base.tools + 1, ...common };
        return this.snapshot;
      }
      case 'turn/end': {
        const turnData = (data ?? {}) as TurnEndData;
        const kind = turnData.reason?.kind;
        const errorMessage = turnData.reason?.error?.message;
        this.snapshot = {
          ...base,
          ...(turnData.turn === undefined ? {} : { turn: turnData.turn }),
          ...(time === undefined ? {} : { endedAt: time }),
          state: stateForTurnEnd(kind),
          ...(kind === undefined ? {} : { terminalKind: kind }),
          ...(errorMessage === undefined ? {} : { errorMessage }),
          ...common,
        };
        return this.snapshot;
      }
      default: {
        this.snapshot = { ...base, ...common };
        return this.snapshot;
      }
    }
  }

  /** The current snapshot. */
  get(): StatusSnapshot {
    return this.snapshot;
  }

  /** Reset to the pre-turn state (used by `/new` and `/resume`). */
  reset(): void {
    this.snapshot = INITIAL;
  }
}

/** Map a `turn/end` reason kind to the derived state. */
export function stateForTurnEnd(kind: string | undefined): StatusState {
  switch (kind) {
    case undefined:
    case 'completed':
    case 'forked':
      return 'completed';
    case 'error':
    case 'max-tokens':
      return 'failed';
    case 'blocked':
      return 'waiting-approval';
    case 'aborted':
    case 'interrupted':
      return 'interrupted';
    default:
      return 'completed';
  }
}

/** Human label for a state (Chinese, as the surface speaks Chinese). */
export function statusLabel(state: StatusState): string {
  switch (state) {
    case 'waiting-input':
      return '等待输入';
    case 'running':
      return '运行中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'waiting-approval':
      return '待审批';
    case 'interrupted':
      return '已中断';
  }
}

/** Card header template colour per state. */
export function statusTemplate(state: StatusState): string {
  switch (state) {
    case 'running':
      return 'blue';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'waiting-approval':
      return 'orange';
    case 'interrupted':
      return 'grey';
    case 'waiting-input':
      return 'grey';
  }
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const date = new Date(ms);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}Z`;
}

export interface StatusTextOptions {
  readonly title?: string;
  readonly sessionId?: string;
}

/**
 * Render `/status` and the status card body.
 *
 * Two sessions that differ only in activity always produce different text:
 * the state label, the running flag, the step count and the timestamps all
 * change (design doc A17).
 */
export function statusText(snapshot: StatusSnapshot, options: StatusTextOptions = {}): string {
  const running = snapshot.state === 'running';
  const lines = [
    `会话：${options.title ?? '标题生成中'}`,
    `状态：${statusLabel(snapshot.state)}${terminalDetail(snapshot)}`,
    `是否在跑：${running ? '是' : '否'}`,
    `步数：${snapshot.steps}（工具 ${snapshot.tools}）`,
    `起止：${formatTime(snapshot.startedAt)} → ${formatTime(snapshot.endedAt)}`,
    `最近事件：${snapshot.lastEventType ?? '（无）'}`,
  ];
  if (options.sessionId !== undefined) lines.push(`会话 ID：${options.sessionId}`);
  return lines.join('\n');
}

function terminalDetail(snapshot: StatusSnapshot): string {
  if (snapshot.state === 'failed' && snapshot.errorMessage !== undefined) {
    return `（${snapshot.errorMessage}）`;
  }
  if (snapshot.terminalKind !== undefined && snapshot.state !== 'completed') {
    return `（${snapshot.terminalKind}）`;
  }
  return '';
}

/** Status card lines (the same body as `/status`, options included). */
export function statusCardLines(
  snapshot: StatusSnapshot,
  options: StatusTextOptions = {},
): string[] {
  return statusText(snapshot, options).split('\n');
}

/** Reasons that must proactively notify the user without being asked. */
export function shouldNotifyTerminal(kind: string | undefined): boolean {
  return kind === 'error' || kind === 'interrupted' || kind === 'blocked';
}

/** The proactive terminal notice text, or `undefined` for silent endings. */
export function terminalNotice(kind: string | undefined, errorMessage?: string): string | undefined {
  switch (kind) {
    case 'error':
      return `⚠️ 本轮失败：${errorMessage ?? '未知错误'}`;
    case 'interrupted':
      return '⏸️ 本轮被中断，会话已回到空闲。';
    case 'blocked':
      return '⏳ 本轮阻塞：等待审批或补充输入，请回复后继续。';
    default:
      return undefined;
  }
}
