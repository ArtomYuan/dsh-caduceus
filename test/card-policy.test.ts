import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CARD_POLICY,
  cardPolicyFromSettings,
  foldsAtTurnEnd,
  formatStepLines,
  showsStepElapsed,
  showsToolCount,
  stepLimit,
  stepLinesFromEvents,
} from '../src/card-policy.js';

test('cardPolicyFromSettings：读 ui-chat 与 ui-settings-general 的活值', () => {
  const policy = cardPolicyFromSettings([
    {
      ns: 'ui-chat',
      value: {
        transcriptView: 'detailed',
        collapseTiming: 'next-input',
        foldedReplies: 'all',
        performanceUsage: 'detailed',
      },
    },
    { ns: 'ui-settings-general', value: { developerTools: true } },
  ]);
  assert.deepEqual(policy, {
    transcript: 'detailed',
    collapseTiming: 'next-input',
    foldedReplies: 'all',
    developerTools: true,
    performance: 'detailed',
  });
});

test('cardPolicyFromSettings：缺服务/缺字段/非法值都回落到 dsh 默认', () => {
  assert.deepEqual(cardPolicyFromSettings(undefined), DEFAULT_CARD_POLICY);
  assert.deepEqual(cardPolicyFromSettings([]), DEFAULT_CARD_POLICY);
  const partial = cardPolicyFromSettings([
    { ns: 'ui-chat', value: { transcriptView: 'nonsense', performanceUsage: 42 } },
    { id: 'ui-settings-general', value: { developerTools: 'yes' } },
  ]);
  assert.equal(partial.transcript, 'compact');
  assert.equal(partial.performance, 'compact');
  assert.equal(partial.developerTools, false);
});

test('cardPolicyFromSettings：按 id 兜底匹配（describe 条目两种键都认）', () => {
  const policy = cardPolicyFromSettings([{ id: 'ui-chat', value: { transcriptView: 'verbose' } }]);
  assert.equal(policy.transcript, 'verbose');
});

test('档位 → 步骤条数/细节/收起时机', () => {
  assert.equal(stepLimit('compact'), 1);
  assert.equal(stepLimit('standard'), 3);
  assert.equal(stepLimit('detailed'), 5);
  assert.equal(stepLimit('verbose'), Number.POSITIVE_INFINITY);
  assert.equal(showsStepElapsed('standard'), false);
  assert.equal(showsStepElapsed('detailed'), true);
  assert.equal(showsToolCount('compact'), false);
  assert.equal(showsToolCount('standard'), true);
  assert.equal(foldsAtTurnEnd({ ...DEFAULT_CARD_POLICY, collapseTiming: 'completion' }), true);
  assert.equal(foldsAtTurnEnd({ ...DEFAULT_CARD_POLICY, collapseTiming: 'next-input' }), false);
});

function call(callId: string, name: string, time: number, turn = 1): unknown {
  return { type: 'tool/call', time, data: { turn, step: 1, callId, name } };
}

function result(callId: string, time: number, turn = 1): unknown {
  return {
    type: 'tool/result',
    time,
    data: { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId } } },
  };
}

test('stepLinesFromEvents：配对出耗时、按 turn 过滤、按档位截断', () => {
  const events = [
    call('a', 'bash', 1_000),
    result('a', 1_500),
    call('b', 'read', 2_000),
    call('c', 'edit', 3_000),
    result('c', 3_250),
    call('d', 'grep', 4_000),
    result('d', 4_100),
    call('old', 'older', 10, 9),
  ];

  const all = stepLinesFromEvents(events, Number.POSITIVE_INFINITY, { turn: 1, elapsed: true });
  assert.deepEqual(
    all.map((line) => line.label),
    ['bash', 'read', 'edit', 'grep'],
    'other turns are filtered out',
  );
  assert.equal(all[0]?.done, true);
  assert.equal(all[0]?.durationMs, 500);
  assert.equal(all[1]?.done, false, 'a call without a result stays pending');
  assert.equal(all[1]?.durationMs, undefined);

  const limited = stepLinesFromEvents(events, 2, { turn: 1 });
  assert.deepEqual(
    limited.map((line) => line.label),
    ['edit', 'grep'],
    'the last N calls win',
  );
  assert.equal(limited[0]?.durationMs, undefined, 'elapsed is off unless the level asks for it');
});

test('formatStepLines：一行一个工具，带状态符号与耗时', () => {
  const lines = formatStepLines([
    { label: 'bash', done: true, durationMs: 1_234 },
    { label: 'read', done: false },
  ]);
  assert.deepEqual(lines, ['✓ bash · 1.2s', '▸ read']);
});
