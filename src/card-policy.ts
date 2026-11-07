/**
 * Card presentation policy — mirrors dsh's own Chat/General settings so the
 * Feishu card shows the same amount of process detail as the Web UI instead of
 * inventing a second set of knobs.
 *
 * Read live from the `settings` service (`describe()`), which returns the
 * active profile's entry values:
 *
 * - `ui-chat.transcriptView`            工作步骤展示
 * - `ui-chat.collapseTiming`            工作步骤收起时机
 * - `ui-chat.foldedReplies`             收起后显示的回复
 * - `ui-chat.performanceUsage`          性能与用量
 * - `ui-settings-general.developerTools` 显示代码工作视图
 *
 * @module dsh-caduceus/card-policy
 */

/** Transcript detail levels accepted by dsh's Chat settings. */
export const TRANSCRIPT_MODES = ['compact', 'standard', 'detailed', 'verbose'] as const;
export type TranscriptMode = (typeof TRANSCRIPT_MODES)[number];

/** When the completed turn's process folds away. */
export const COLLAPSE_TIMINGS = ['completion', 'next-input'] as const;
export type CollapseTiming = (typeof COLLAPSE_TIMINGS)[number];

/** Which assistant replies stay visible once the process folds. */
export const FOLDED_REPLIES = ['all', 'final'] as const;
export type FoldedReplies = (typeof FOLDED_REPLIES)[number];

/** Performance/usage line density. */
export const PERFORMANCE_MODES = ['compact', 'detailed'] as const;
export type PerformanceMode = (typeof PERFORMANCE_MODES)[number];

/** Everything the card renderer needs to know about the user's detail level. */
export interface CardPolicy {
  readonly transcript: TranscriptMode;
  readonly collapseTiming: CollapseTiming;
  readonly foldedReplies: FoldedReplies;
  readonly developerTools: boolean;
  readonly performance: PerformanceMode;
}

/**
 * dsh's shipped defaults. Used only when the settings service is unavailable
 * (headless boot, older runtime) — never as a user-facing default override.
 */
export const DEFAULT_CARD_POLICY: CardPolicy = {
  transcript: 'compact',
  collapseTiming: 'completion',
  foldedReplies: 'final',
  developerTools: false,
  performance: 'compact',
};

/** One `settings.describe()` entry, narrowed to what the policy reads. */
export interface SettingsEntryLike {
  readonly ns?: unknown;
  readonly id?: unknown;
  readonly value?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function entryValue(
  entries: readonly SettingsEntryLike[],
  namespace: string,
): Record<string, unknown> | undefined {
  for (const entry of entries) {
    const key = typeof entry.ns === 'string' ? entry.ns : entry.id;
    if (key === namespace) return asRecord(entry.value);
  }
  return undefined;
}

function pick<T extends string>(
  record: Record<string, unknown> | undefined,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = record?.[field];
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * Map live settings entries onto the card policy. Unknown or malformed values
 * fall back to dsh's defaults per field, so one bad field never blanks the card.
 */
export function cardPolicyFromSettings(
  entries: readonly SettingsEntryLike[] | undefined,
): CardPolicy {
  if (entries === undefined) return DEFAULT_CARD_POLICY;
  const chat = entryValue(entries, 'ui-chat');
  const general = entryValue(entries, 'ui-settings-general');
  const developerTools = general?.['developerTools'];
  return {
    transcript: pick(chat, 'transcriptView', TRANSCRIPT_MODES, DEFAULT_CARD_POLICY.transcript),
    collapseTiming: pick(
      chat,
      'collapseTiming',
      COLLAPSE_TIMINGS,
      DEFAULT_CARD_POLICY.collapseTiming,
    ),
    foldedReplies: pick(
      chat,
      'foldedReplies',
      FOLDED_REPLIES,
      DEFAULT_CARD_POLICY.foldedReplies,
    ),
    developerTools:
      typeof developerTools === 'boolean' ? developerTools : DEFAULT_CARD_POLICY.developerTools,
    performance: pick(
      chat,
      'performanceUsage',
      PERFORMANCE_MODES,
      DEFAULT_CARD_POLICY.performance,
    ),
  };
}

/** How many step lines a transcript mode shows; `Infinity` = the whole turn. */
export function stepLimit(mode: TranscriptMode): number {
  switch (mode) {
    case 'compact':
      return 1;
    case 'standard':
      return 3;
    case 'detailed':
      return 5;
    case 'verbose':
      return Number.POSITIVE_INFINITY;
  }
}

/** Per-step elapsed time is part of the `detailed` and `verbose` levels. */
export function showsStepElapsed(mode: TranscriptMode): boolean {
  return mode === 'detailed' || mode === 'verbose';
}

/** Tool invocation total belongs to `detailed` and up. */
export function showsToolCount(mode: TranscriptMode): boolean {
  return mode !== 'compact';
}

/** Fold the process card as soon as the turn ends (`next-input` defers it). */
export function foldsAtTurnEnd(policy: CardPolicy): boolean {
  return policy.collapseTiming === 'completion';
}

/** One rendered step line. */
export interface StepLine {
  readonly label: string;
  readonly done: boolean;
  readonly durationMs?: number;
}

interface ToolCallLike {
  readonly type?: unknown;
  readonly time?: unknown;
  readonly data?: unknown;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Reduce the in-memory event window to step lines for the current turn.
 *
 * `tool/call` carries the name and `tool/result` carries the matching
 * `message.source.callId`, so a call is `done` once its result arrives and the
 * pair yields a duration. Only the last `limit` lines are returned; callers
 * surface the total separately.
 */
export function stepLinesFromEvents(
  events: readonly unknown[],
  limit: number,
  options: { readonly turn?: number; readonly elapsed?: boolean } = {},
): StepLine[] {
  const calls = new Map<string, { label: string; at: number; done: boolean; durationMs?: number }>();
  const order: string[] = [];
  for (const raw of events) {
    const event = asRecord(raw) as ToolCallLike | undefined;
    if (event === undefined) continue;
    const data = asRecord(event.data);
    if (data === undefined) continue;
    if (options.turn !== undefined) {
      const turn = data['turn'];
      if (typeof turn === 'number' && turn !== options.turn) continue;
    }
    const time = typeof event.time === 'number' ? event.time : undefined;
    if (event.type === 'tool/call') {
      const callId = typeof data['callId'] === 'string' ? data['callId'] : undefined;
      const name = typeof data['name'] === 'string' ? data['name'] : '调用';
      if (callId === undefined) continue;
      calls.set(callId, { label: name, at: time ?? 0, done: false });
      order.push(callId);
      continue;
    }
    if (event.type === 'tool/result') {
      const message = asRecord(data['message']);
      const source = asRecord(message?.['source']);
      const callId = typeof source?.['callId'] === 'string' ? source['callId'] : undefined;
      if (callId === undefined) continue;
      const entry = calls.get(callId);
      if (entry === undefined) continue;
      entry.done = true;
      if (time !== undefined && entry.at > 0) entry.durationMs = Math.max(0, time - entry.at);
    }
  }
  const lines: StepLine[] = order
    .map((callId) => calls.get(callId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .map((entry) => ({
      label: entry.label,
      done: entry.done,
      ...(options.elapsed === true && entry.durationMs !== undefined
        ? { durationMs: entry.durationMs }
        : {}),
    }));
  if (!Number.isFinite(limit)) return lines;
  return lines.slice(Math.max(0, lines.length - limit));
}

/** Render step lines the way the card shows them: one tool per row. */
export function formatStepLines(lines: readonly StepLine[]): string[] {
  return lines.map((line) => {
    const mark = line.done ? '✓' : '▸';
    const duration = line.durationMs === undefined ? '' : ` · ${seconds(line.durationMs)}`;
    return `${mark} ${line.label}${duration}`;
  });
}
