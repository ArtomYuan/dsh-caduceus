/**
 * Gate decisions (all six must be traceable), startup-line secret hygiene,
 * and session-scope line formatting.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateGate,
  formatGateLine,
  logGate,
  type GateDecision,
  type GateInput,
  type GateLogInfo,
} from '../src/gate.js';
import {
  formatScopeLine,
  formatStartupLine,
  maskAppId,
  scopeKind,
  sessionIdTimestamp,
  sessionTimeLabel,
  shortSessionId,
} from '../src/observability.js';
import { FakeLogger } from './support/fakes.js';

const chatId = 'oc_123456789012345';
const threadId = 'omt_123456789012';
const senderOpenId = 'ou_123456789012';

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    chatType: 'group',
    chatId,
    threadId,
    senderOpenId,
    text: 'hello',
    allowedChats: [],
    allowedUsers: [],
    botOpenId: 'ou_bot',
    ...overrides,
  };
}

function info(overrides: Partial<GateLogInfo> = {}): GateLogInfo {
  return { chatId, threadId, senderOpenId, ...overrides };
}

test('门禁六种判定各有一条可追行（记录型 logger）', () => {
  const logger = new FakeLogger();
  const scenarios: { readonly decision: GateDecision; readonly info: GateLogInfo }[] = [
    { decision: evaluateGate(input({ chatType: 'p2p' })), info: info() },
    { decision: evaluateGate(input({ mentions: ['ou_bot'] })), info: info() },
    { decision: evaluateGate(input()), info: info() },
    {
      decision: evaluateGate(input({ senderType: 'app', mentions: ['ou_bot'] })),
      info: info({ senderType: 'app' }),
    },
    {
      decision: evaluateGate(input({ chatType: 'p2p', allowedChats: ['oc_other'] })),
      info: info(),
    },
    {
      decision: evaluateGate(input({ chatType: 'p2p', allowedUsers: ['ou_other'] })),
      info: info(),
    },
    { decision: evaluateGate(input({ chatType: 'p2p', text: '   ' })), info: info() },
  ];
  for (const scenario of scenarios) logGate(logger, scenario.decision, scenario.info);

  const lines = logger.entries.filter((entry) => entry.level === 'info').map((entry) => entry.message);
  assert.equal(lines.length, 7);
  assert.ok(lines.some((line) => line.startsWith('gate accept: p2p ')));
  assert.ok(lines.some((line) => line.startsWith('gate accept: mentioned ')));
  assert.ok(lines.some((line) => line.startsWith('gate drop: no-mention ')));
  assert.ok(lines.some((line) => line.startsWith('gate drop: bot-sender sender_type=app ')));
  assert.ok(lines.some((line) => line.startsWith('gate drop: not-allowed-chat ')));
  assert.ok(lines.some((line) => line.startsWith('gate drop: not-allowed-user ')));
  assert.ok(lines.some((line) => line.startsWith('gate drop: empty-text ')));
  // Context prefixes are truncated to 12 chars.
  for (const line of lines) {
    assert.ok(line.includes(`chat=${chatId.slice(0, 12)}`), line);
    assert.ok(line.includes(`thread=${threadId.slice(0, 12)}`), line);
    assert.ok(line.includes(`sender=${senderOpenId.slice(0, 12)}`), line);
  }
});

test('门禁：bot open id 未知时带 mention 放行，空 mention 仍丢弃', () => {
  assert.deepEqual(evaluateGate(input({ botOpenId: undefined, mentions: ['ou_any'] })), {
    accept: true,
    reason: 'mentioned',
  });
  assert.deepEqual(evaluateGate(input({ botOpenId: undefined, mentions: [] })), {
    accept: false,
    reason: 'no-mention',
  });
  assert.equal(
    formatGateLine({ accept: true, reason: 'p2p' }, { chatId, senderOpenId }),
    `gate accept: p2p chat=${chatId.slice(0, 12)} thread=- sender=${senderOpenId.slice(0, 12)}`,
  );
});

test('启动行：appId 只露前缀+后 4 位，appSecret 任何片段都不出现', () => {
  const appSecret = 'super-secret-value-9f8e7d';
  const line = formatStartupLine({
    appId: 'cli_a1b2c3d4e5f6',
    appSecret,
    defaultCwd: '/tmp/work',
    groupSessionsPerUser: true,
    cardThrottleMs: 400,
    busyMode: 'queue',
  });
  assert.equal(
    line,
    'ready appId=cli_a1b…e5f6 defaultCwd=/tmp/work groupSessionsPerUser=true throttle=400 busyMode=queue',
  );
  assert.ok(!line.includes(appSecret));
  for (let index = 0; index + 4 <= appSecret.length; index += 1) {
    assert.ok(!line.includes(appSecret.slice(index, index + 4)), 'secret fragment leaked');
  }
  assert.equal(maskAppId(undefined), '(missing)');
  assert.equal(maskAppId('short'), 'short');
});

test('scope 行：kind=p2p/topic/group-user/group-shared，key 前 16 位且 NUL 可读', () => {
  const p2p = formatScopeLine('p2p', 'oc_chat', 'feishu-12345678', true);
  assert.equal(p2p, 'scope: kind=p2p key=oc_chat session=12345678');

  const topicKey = 'oc_chat\u0000omt_topic1234567890';
  assert.equal(scopeKind('group', topicKey, true), 'topic');
  const topic = formatScopeLine('group', topicKey, 'feishu-12345678', true);
  assert.equal(topic, 'scope: kind=topic key=oc_chat\\0omt_topi session=12345678');

  const userKey = 'oc_chat\u0000ou_user1234567890';
  assert.equal(scopeKind('group', userKey, true), 'group-user');
  assert.equal(formatScopeLine('group', userKey, 'feishu-abcdef12', true),
    'scope: kind=group-user key=oc_chat\\0ou_user1 session=abcdef12');

  assert.equal(scopeKind('group', 'oc_chat', false), 'group-shared');
  assert.equal(formatScopeLine('group', 'oc_chat', 'feishu-abcdef12', false),
    'scope: kind=group-shared key=oc_chat session=abcdef12');
});

test('会话 id：展示尾 8 位，epoch 解析与相对时间格式化', () => {
  const id = 'feishu-1793460837083';
  assert.equal(shortSessionId(id), id.slice(-8));
  assert.equal(shortSessionId('short'), 'short');

  const now = Date.parse('2026-10-31T23:00:00Z');
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;

  assert.equal(sessionIdTimestamp(`feishu-${fiveMinutesAgo}`), fiveMinutesAgo);
  assert.equal(sessionIdTimestamp('feishu-legacy-01'), undefined);
  assert.equal(sessionIdTimestamp('feishu-123'), undefined);
  assert.equal(sessionTimeLabel(fiveMinutesAgo, now), '5 分钟前');
  assert.equal(sessionTimeLabel(twoHoursAgo, now), '2 小时前');
  assert.equal(sessionTimeLabel(now - 1_000, now), '刚刚');
  assert.equal(sessionTimeLabel(threeDaysAgo, now), '10-28 23:00');
  assert.equal(sessionTimeLabel(undefined, now), '—');
});
