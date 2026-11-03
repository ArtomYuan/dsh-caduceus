/**
 * Token-usage aggregation from a session log (`sessionQuery.readSession`).
 *
 * The in-memory StatusTracker still feeds the process card, but `/usage` must
 * work on a freshly restarted gateway, so it aggregates the durable event log
 * instead.
 *
 * @module dsh-caduceus/usage
 */
import type { UsageTotals } from './status.js';

export interface UsageTurn {
  readonly turn: number;
  readonly usage: UsageTotals;
}

export interface UsageReport {
  /** Per-turn totals, ordered by turn descending (newest first). */
  readonly turns: readonly UsageTurn[];
  readonly total: UsageTotals;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function usageOf(value: unknown): UsageTotals | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const num = (key: string): number =>
    typeof record[key] === 'number' ? (record[key] as number) : 0;
  const input = num('inputTokens');
  const output = num('outputTokens');
  const cacheRead = num('cacheReadTokens');
  const cacheWrite = num('cacheWriteTokens');
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  const total =
    typeof record['totalTokens'] === 'number'
      ? (record['totalTokens'] as number)
      : input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function add(total: UsageTotals, delta: UsageTotals): UsageTotals {
  return {
    input: total.input + delta.input,
    output: total.output + delta.output,
    cacheRead: total.cacheRead + delta.cacheRead,
    cacheWrite: total.cacheWrite + delta.cacheWrite,
    total: total.total + delta.total,
  };
}

const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Aggregate every `assistant/message` usage event, grouped by `data.turn`. */
export function aggregateUsage(events: readonly unknown[]): UsageReport {
  const byTurn = new Map<number, UsageTotals>();
  let total = ZERO;
  for (const event of events) {
    const row = asRecord(event);
    if (row?.type !== 'assistant/message') continue;
    const data = asRecord(row.data);
    if (data === undefined) continue;
    const usage = usageOf(data.usage);
    if (usage === undefined) continue;
    const turn = typeof data.turn === 'number' ? data.turn : 0;
    byTurn.set(turn, add(byTurn.get(turn) ?? ZERO, usage));
    total = add(total, usage);
  }
  const turns = [...byTurn.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([turn, usage]) => ({ turn, usage }));
  return { turns, total };
}

function line(label: string, usage: UsageTotals): string {
  return (
    label +
    '：输入 ' +
    usage.input +
    ' · 输出 ' +
    usage.output +
    ' · 缓存命中 ' +
    usage.cacheRead +
    ' · 合计 ' +
    usage.total
  );
}

/** Render the three-line usage report; empty log is a distinct state. */
export function renderUsageReport(report: UsageReport): string {
  if (report.turns.length === 0) return '会话里还没有用量记录';
  const current = report.turns[0] as UsageTurn;
  const previous = report.turns[1];
  return [
    line('本回合', current.usage),
    previous === undefined ? '上回合：暂无' : line('上回合', previous.usage),
    line('会话合计', report.total),
  ].join('\n');
}
