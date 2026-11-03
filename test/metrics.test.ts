/** Metrics aggregation/formatting from durable session events. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateMetrics, formatMetricsLine, formatTokenCount } from '../src/metrics.js';

function ev(type: string, data: Record<string, unknown>, time?: number): unknown {
  return { type, data, ...(time === undefined ? {} : { time }) };
}

test('数字格式：999 / 1.6k / 7.9M', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1560), '1.6k');
  assert.equal(formatTokenCount(7_860_000), '7.9M');
});

test('轮数/步数/累计 token/缓存命中', () => {
  const metrics = aggregateMetrics([
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1 }),
    ev('assistant/message', { turn: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, totalTokens: 1010 } }),
    ev('turn/end', { turn: 1 }),
  ]);
  assert.equal(metrics.rounds, 1);
  assert.equal(metrics.steps, 1);
  assert.equal(metrics.totalTokens, 1010);
  assert.equal(metrics.cacheHitPercent, 90);
});

test('tok/s：本回合 output / 耗时秒', () => {
  const metrics = aggregateMetrics([
    ev('turn/start', { turn: 1 }, 1000),
    ev('assistant/message', { turn: 1, usage: { inputTokens: 1, outputTokens: 500 } }, 3000),
    ev('turn/end', { turn: 1 }, 3000),
  ]);
  assert.equal(metrics.tokensPerSecond, 250);
});

test('tok/s：不足 1 秒或缺时间不显示', () => {
  assert.equal(
    aggregateMetrics([
      ev('turn/start', { turn: 1 }, 1000),
      ev('assistant/message', { turn: 1, usage: { outputTokens: 10 } }, 1500),
      ev('turn/end', { turn: 1 }, 1500),
    ]).tokensPerSecond,
    undefined,
  );
  assert.equal(
    aggregateMetrics([ev('assistant/message', { turn: 1, usage: { outputTokens: 10 } })]).tokensPerSecond,
    undefined,
  );
});

test('缓存命中率：0 分母不显示，100% 正常', () => {
  assert.equal(
    aggregateMetrics([ev('assistant/message', { turn: 1, usage: { outputTokens: 5 } })]).cacheHitPercent,
    undefined,
  );
  assert.equal(
    aggregateMetrics([
      ev('assistant/message', { turn: 1, usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 100 } }),
    ]).cacheHitPercent,
    100,
  );
});

test('上下文：request/context window 与上一回合 prompt 之比', () => {
  const metrics = aggregateMetrics([
    ev('turn/start', { turn: 1 }),
    ev('assistant/message', { turn: 1, usage: { inputTokens: 500, cacheReadTokens: 500 } }),
    ev('turn/end', { turn: 1 }),
    ev('turn/start', { turn: 2 }),
    ev('request/context', { contextWindow: 10_000 }),
    ev('assistant/message', { turn: 2, usage: { inputTokens: 100, outputTokens: 5 } }),
  ]);
  assert.equal(metrics.contextPercent, 10);
});

test('上下文：window 缺失则不显示', () => {
  const metrics = aggregateMetrics([
    ev('assistant/message', { turn: 1, usage: { inputTokens: 500 } }),
    ev('assistant/message', { turn: 2, usage: { inputTokens: 100 } }),
  ]);
  assert.equal(metrics.contextPercent, undefined);
});

test('compact/detailed/off 行格式', () => {
  const metrics = {
    rounds: 4,
    steps: 12,
    tokensPerSecond: 156,
    totalTokens: 7_860_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheHitPercent: 99,
    contextPercent: 18,
  };
  assert.equal(
    formatMetricsLine(metrics, 'compact'),
    '4 轮 · 12 步 · 156 tok/s · 7.9M tok · 缓存 99%',
  );
  assert.equal(
    formatMetricsLine(metrics, 'detailed'),
    '4 轮 · 12 步 · 156 tok/s · 7.9M tok · 缓存 99% · 上下文 18%',
  );
  assert.equal(formatMetricsLine(metrics, 'off'), '');
});
