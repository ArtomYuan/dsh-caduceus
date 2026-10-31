/**
 * Status-layer tests: state derivation from the four boundary events, step
 * counting, timestamps, and the proactive terminal-notice policy.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StatusTracker,
  shouldNotifyTerminal,
  statusLabel,
  statusText,
  terminalNotice,
  type StatusEventLike,
} from '../src/status.js';

function event(type: string, data: unknown, time = 0): StatusEventLike {
  return { type, data, time };
}

test('初始状态为空闲，/status 文本非空且可区分', () => {
  const tracker = new StatusTracker();
  const idle = tracker.get();
  assert.equal(idle.state, 'idle');
  assert.equal(statusLabel(idle.state), '空闲');
  assert.match(statusText(idle), /状态：空闲/);

  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  const running = tracker.get();
  assert.equal(running.state, 'running');
  assert.match(statusText(running), /状态：运行中/);
  assert.match(statusText(running), /是否在跑：是/);
  assert.notEqual(statusText(idle), statusText(running));
});

test('步数来自 step/start 计数，工具调用单独计数', () => {
  const tracker = new StatusTracker();
  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  tracker.apply(event('step/start', { turn: 1, step: 1 }, 1_100));
  assert.equal(tracker.get().steps, 1);
  tracker.apply(event('step/end', { turn: 1, step: 1 }, 1_200));
  tracker.apply(event('tool/call', { turn: 1, step: 1, callId: 'c1' }, 1_300));
  tracker.apply(event('step/start', { turn: 1, step: 2 }, 1_400));
  assert.equal(tracker.get().steps, 2);
  assert.equal(tracker.get().tools, 1);
  assert.equal(tracker.get().startedAt, 1_000);
});

test('终态 1/4：completed → 完成（定格起止时间）', () => {
  const tracker = new StatusTracker();
  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  tracker.apply(event('step/start', { turn: 1, step: 1 }, 1_100));
  tracker.apply(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000));
  const snapshot = tracker.get();
  assert.equal(snapshot.state, 'completed');
  assert.equal(statusLabel(snapshot.state), '完成');
  assert.equal(snapshot.endedAt, 2_000);
  assert.equal(snapshot.steps, 1);
  assert.equal(shouldNotifyTerminal(snapshot.terminalKind), false);
});

test('终态 2/4：error → 失败并保留错误文本', () => {
  const tracker = new StatusTracker();
  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  tracker.apply(
    event(
      'turn/end',
      {
        turn: 1,
        reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'provider exploded' } },
      },
      2_000,
    ),
  );
  const snapshot = tracker.get();
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.errorMessage, 'provider exploded');
  assert.match(statusText(snapshot), /失败/);
  assert.equal(shouldNotifyTerminal(snapshot.terminalKind), true);
  assert.match(terminalNotice(snapshot.terminalKind, snapshot.errorMessage) ?? '', /provider exploded/);
});

test('终态 3/4：blocked → 待审批并主动通知', () => {
  const tracker = new StatusTracker();
  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  tracker.apply(event('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 2_000));
  const snapshot = tracker.get();
  assert.equal(snapshot.state, 'waiting-approval');
  assert.equal(statusLabel(snapshot.state), '待审批');
  assert.equal(shouldNotifyTerminal(snapshot.terminalKind), true);
  assert.match(terminalNotice(snapshot.terminalKind) ?? '', /等待审批/);
});

test('终态 4/4：aborted / interrupted → 已中断', () => {
  for (const kind of ['aborted', 'interrupted']) {
    const tracker = new StatusTracker();
    tracker.apply(event('turn/start', { turn: 1 }, 1_000));
    tracker.apply(event('turn/end', { turn: 1, reason: { kind } }, 2_000));
    const snapshot = tracker.get();
    assert.equal(snapshot.state, 'interrupted', `kind ${kind}`);
    assert.equal(statusLabel(snapshot.state), '已中断');
    assert.equal(shouldNotifyTerminal(kind), kind === 'interrupted');
  }
});

test('max-tokens 归入失败（需要续写）', () => {
  const tracker = new StatusTracker();
  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  tracker.apply(event('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 2_000));
  assert.equal(tracker.get().state, 'failed');
});

test('reset 回到空闲', () => {
  const tracker = new StatusTracker();
  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  tracker.apply(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000));
  tracker.reset();
  assert.equal(tracker.get().state, 'idle');
  assert.equal(tracker.get().steps, 0);
});

test('只有 error/interrupted/blocked 触发主动推送', () => {
  assert.equal(shouldNotifyTerminal('error'), true);
  assert.equal(shouldNotifyTerminal('interrupted'), true);
  assert.equal(shouldNotifyTerminal('blocked'), true);
  assert.equal(shouldNotifyTerminal('completed'), false);
  assert.equal(shouldNotifyTerminal('aborted'), false);
  assert.equal(shouldNotifyTerminal(undefined), false);
  assert.equal(terminalNotice('completed'), undefined);
  assert.equal(terminalNotice(undefined), undefined);
});

test('/status 三态：空闲 → 运行中 → 完成', () => {
  const tracker = new StatusTracker();
  assert.equal(statusLabel(tracker.get().state), '空闲');

  tracker.apply(event('turn/start', { turn: 1 }, 1_000));
  assert.equal(statusLabel(tracker.get().state), '运行中');

  tracker.apply(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000));
  assert.equal(statusLabel(tracker.get().state), '完成');
  assert.equal(statusLabel(tracker.get().state), '完成', 'a completed turn stays 完成');
});
