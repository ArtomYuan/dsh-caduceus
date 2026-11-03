/**
 * Card/`/usage` metrics aggregated from durable session events:
 * rounds, steps, tok/s, cumulative tokens, cache hit rate, context usage.
 *
 * These are deliberately derived from the event log (not the in-memory status
 * tracker), so a restarted gateway can still show the same numbers.
 *
 * @module dsh-caduceus/metrics
 */
export type MetricsMode = 'off' | 'compact' | 'detailed';

export interface Metrics {
  readonly rounds: number;
  readonly steps: number;
  readonly tokensPerSecond?: number;
  readonly totalTokens: number;
  /** Raw sums (used when merging an in-flight turn with the full log). */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheHitPercent?: number;
  readonly contextPercent?: number;
}

interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' ? value : 0;
}

function usageDelta(value: unknown): UsageDelta | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const input = num(record, 'inputTokens');
  const output = num(record, 'outputTokens');
  const cacheRead = num(record, 'cacheReadTokens');
  const cacheWrite = num(record, 'cacheWriteTokens');
  const providerTotal =
    typeof record['totalTokens'] === 'number' ? (record['totalTokens'] as number) : 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && providerTotal === 0) {
    return undefined;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total:
      providerTotal > 0 ? providerTotal : input + output + cacheRead + cacheWrite,
  };
}

/** Aggregate metrics from one session event sequence. */
export function aggregateMetrics(events: readonly unknown[]): Metrics {
  let rounds = 0;
  let steps = 0;
  let totalTokens = 0;
  let cacheRead = 0;
  let input = 0;
  let outputTotal = 0;
  const outputByTurn = new Map<number, number>();
  const promptByTurn = new Map<number, number>();
  const startByTurn = new Map<number, number>();
  const endByTurn = new Map<number, number>();
  let lastEventAt: number | undefined;
  let contextWindow: number | undefined;

  for (const event of events) {
    const row = asRecord(event);
    if (row === undefined) continue;
    const data = asRecord(row.data);
    const time = typeof row.time === 'number' ? row.time : undefined;
    if (time !== undefined) lastEventAt = time;
    const turn = typeof data?.['turn'] === 'number' ? (data['turn'] as number) : undefined;
    if (turn !== undefined) rounds = Math.max(rounds, turn);
    if (row.type === 'turn/start' && turn !== undefined && time !== undefined) {
      startByTurn.set(turn, time);
    }
    if (row.type === 'turn/end' && turn !== undefined && time !== undefined) {
      endByTurn.set(turn, time);
    }
    if (row.type === 'step/start') steps += 1;
    if (row.type === 'request/context') {
      const window = num(data, 'contextWindow');
      if (window > 0) contextWindow = window;
    }
    if (row.type !== 'assistant/message') continue;
    const delta = usageDelta(data?.usage);
    if (delta === undefined) continue;
    totalTokens += delta.total;
    cacheRead += delta.cacheRead;
    input += delta.input;
    outputTotal += delta.output;
    if (turn !== undefined) {
      outputByTurn.set(turn, (outputByTurn.get(turn) ?? 0) + delta.output);
      promptByTurn.set(
        turn,
        (promptByTurn.get(turn) ?? 0) + delta.input + delta.cacheRead + delta.cacheWrite,
      );
    }
  }

  let tokensPerSecond: number | undefined;
  const start = startByTurn.get(rounds);
  const end = endByTurn.get(rounds) ?? lastEventAt;
  const output = outputByTurn.get(rounds) ?? 0;
  if (start !== undefined && end !== undefined && end - start >= 1000 && output > 0) {
    tokensPerSecond = output / ((end - start) / 1000);
  }

  const promptTokens = promptByTurn.get(rounds - 1);
  const contextPercent =
    contextWindow !== undefined && promptTokens !== undefined && contextWindow > 0
      ? Math.round((promptTokens / contextWindow) * 100)
      : undefined;

  const denominator = cacheRead + input;
  const cacheHitPercent = denominator > 0 ? Math.round((cacheRead / denominator) * 100) : undefined;

  return {
    rounds,
    steps,
    totalTokens,
    inputTokens: input,
    outputTokens: outputTotal,
    cacheReadTokens: cacheRead,
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
    ...(contextPercent === undefined ? {} : { contextPercent }),
  };
}

/** Compact number format: 999, 1.6k, 7.9M. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** One-line metrics summary; empty when mode is off or nothing to show. */
export function formatMetricsLine(metrics: Metrics, mode: MetricsMode): string {
  if (mode === 'off') return '';
  const parts: string[] = [];
  if (metrics.rounds > 0) parts.push(`${metrics.rounds} 轮`);
  if (metrics.steps > 0) parts.push(`${metrics.steps} 步`);
  if (metrics.tokensPerSecond !== undefined) {
    parts.push(`${Math.round(metrics.tokensPerSecond)} tok/s`);
  }
  if (metrics.totalTokens > 0) parts.push(`${formatTokenCount(metrics.totalTokens)} tok`);
  if (metrics.cacheHitPercent !== undefined) parts.push(`缓存 ${metrics.cacheHitPercent}%`);
  if (mode === 'detailed' && metrics.contextPercent !== undefined) {
    parts.push(`上下文 ${metrics.contextPercent}%`);
  }
  return parts.join(' · ');
}
