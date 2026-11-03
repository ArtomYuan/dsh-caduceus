/** Session-log usage aggregation: turns, cache fields, missing data, big values. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateUsage, renderUsageReport } from '../src/usage.js';

function event(turn: number, usage: Record<string, number | undefined>): unknown {
  return { type: 'assistant/message', data: { turn, usage } };
}

test('单 turn 多条 usage 求和', () => {
  const report = aggregateUsage([
    event(1, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 }),
    event(1, { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1 }),
  ]);
  assert.equal(report.turns.length, 1);
  assert.deepEqual(report.turns[0]?.usage, {
    input: 15,
    output: 5,
    cacheRead: 5,
    cacheWrite: 0,
    total: 25,
  });
  assert.equal(report.total.total, 25);
});

test('多 turn：最新为当前、次新为上回合', () => {
  const report = aggregateUsage([
    event(1, { inputTokens: 3, outputTokens: 1 }),
    event(3, { inputTokens: 4, outputTokens: 2 }),
    event(2, { inputTokens: 5, outputTokens: 0 }),
  ]);
  const text = renderUsageReport(report);
  assert.match(text, /本回合：输入 4 · 输出 2 · 缓存命中 0 · 合计 6/);
  assert.match(text, /上回合：输入 5 · 输出 0 · 缓存命中 0 · 合计 5/);
  assert.match(text, /会话合计：输入 12 · 输出 3 · 缓存命中 0 · 合计 15/);
});

test('缺 cacheWrite/cacheRead 字段不崩', () => {
  const report = aggregateUsage([event(1, { inputTokens: 4, outputTokens: 1 })]);
  assert.deepEqual(report.total, {
    input: 4,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    total: 5,
  });
  assert.match(renderUsageReport(report), /合计 5/);
});

test('空日志 → 还没有用量记录', () => {
  assert.equal(renderUsageReport(aggregateUsage([])), '会话里还没有用量记录');
  assert.equal(renderUsageReport(aggregateUsage([{ type: 'turn/start', data: {} }])), '会话里还没有用量记录');
});

test('大数不溢出', () => {
  const huge = 1_000_000_000;
  const report = aggregateUsage([event(1, { inputTokens: huge, outputTokens: huge, cacheReadTokens: huge })]);
  assert.equal(report.total.input, huge);
  assert.equal(report.total.total, huge * 3);
  assert.match(renderUsageReport(report), new RegExp(`输入 ${huge}`));
});

test('0 值正常显示', () => {
  const report = aggregateUsage([event(1, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 5 })]);
  assert.equal(report.turns.length, 1);
  assert.match(renderUsageReport(report), /输入 0 · 输出 0 · 缓存命中 0 · 合计 5/);
});

test('cacheWrite 计入合计但不单独显示', () => {
  const report = aggregateUsage([event(1, { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 8 })]);
  assert.equal(report.total.total, 10);
  const text = renderUsageReport(report);
  assert.match(text, /合计 10/);
  assert.ok(!text.includes('cacheWrite'));
  assert.ok(!text.includes('缓存写入'));
});

test('totalTokens 优先于字段相加', () => {
  const report = aggregateUsage([event(1, { inputTokens: 1, outputTokens: 1, totalTokens: 100 })]);
  assert.equal(report.total.total, 100);
});
