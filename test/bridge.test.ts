/**
 * Bridge tests: per-scope serialization, cross-scope parallelism, busy modes,
 * final-answer-as-new-message, terminal notices, command dispatch, and agent
 * resolution failure recovery.
 *
 * Every test injects fake transport/agents/title/clock; session state lives in
 * a `mkdtemp` directory and is deleted afterwards.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { Bridge } from '../src/bridge/bridge.js';
import type { AgentLike, BridgeConfig, BusyMode } from '../src/bridge/types.js';
import type { HarnessCommandResult } from '../src/commands/harness.js';
import { scopeKey, SessionStore } from '../src/session-key.js';
import type { StatusEventLike } from '../src/status.js';
import type { FeishuCard, InboundMessage } from '../src/transport/types.js';
import {
  FakeAgent,
  FakeAgents,
  FakeClock,
  FakeLogger,
  FakeTitleService,
  FakeTransport,
  inbound,
  patchedCards,
  recordedCards,
  recordedTexts,
  tick,
  userMessageText,
} from './support/fakes.js';

interface HarnessOptions {
  readonly busyMode?: BusyMode;
  readonly throttleMs?: number;
  readonly title?: FakeTitleService;
  readonly commandRunner?: (
    agent: AgentLike,
    line: string,
  ) => Promise<HarnessCommandResult | undefined>;
  readonly persona?: (
    action: 'show' | 'sync',
  ) => Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>;
  readonly allowedChats?: readonly string[];
  readonly allowedUsers?: readonly string[];
  /** Bot open id for the group @ gate (FakeTransport exposes it). */
  readonly botOpenId?: string;
  /** Pre-bind the group topic `omt_t` so the topic @-exemption applies. */
  readonly prebindTopic?: boolean;
}

interface Harness {
  readonly dir: string;
  readonly store: SessionStore;
  readonly transport: FakeTransport;
  readonly agents: FakeAgents;
  readonly clock: FakeClock;
  readonly logger: FakeLogger;
  readonly titles: FakeTitleService;
  readonly bridge: Bridge;
}

function makeHarness(t: TestContext, options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let storeSeq = 0;
  const store = new SessionStore({
    filePath: join(dir, 'session-map.json'),
    mint: () => {
      storeSeq += 1;
      return `feishu-store-${storeSeq}`;
    },
  });
  store.load();

  const transport = new FakeTransport(
    options.botOpenId === undefined ? {} : { botOpenId: options.botOpenId },
  );
  const agents = new FakeAgents();
  const clock = new FakeClock();
  const logger = new FakeLogger();
  const titles = options.title ?? new FakeTitleService();
  const config: BridgeConfig = {
    defaultCwd: dir,
    allowedChats: options.allowedChats ?? [],
    allowedUsers: options.allowedUsers ?? [],
    cardThrottleMs: options.throttleMs ?? 400,
    busyMode: options.busyMode ?? 'queue',
  };
  if (options.prebindTopic === true) {
    store.set(scopeKey('oc_chat', 'omt_t'), 'feishu-prebound-1');
  }
  let bridgeSeq = 0;
  const bridge = new Bridge({
    transport,
    sessionMap: store,
    agents,
    config,
    logger,
    clock,
    mintSessionId: () => {
      bridgeSeq += 1;
      return `feishu-bridge-${bridgeSeq}`;
    },
    sessionTitle: titles,
    ...(options.commandRunner === undefined
      ? {}
      : { runHarnessCommand: options.commandRunner }),
    ...(options.persona === undefined ? {} : { persona: options.persona }),
  });
  return { dir, store, transport, agents, clock, logger, titles, bridge };
}

function event(type: string, data: unknown, time = 0): StatusEventLike {
  return { type, data, time };
}

function liveAgent(h: Harness): FakeAgent {
  const agent = [...h.agents.live.values()][0];
  assert.ok(agent !== undefined, 'expected a live fake agent');
  return agent;
}

function cardTitles(cards: { readonly card: FeishuCard }[]): string[] {
  return cards.map((entry) => entry.card.header?.title.content ?? '');
}

test('同键串行：第一条未完成前，第二条不会进入 agent', async (t) => {
  const h = makeHarness(t);
  let release!: () => void;
  h.agents.createGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = h.bridge.handleInbound(inbound('第一条'));
  const second = h.bridge.handleInbound(inbound('第二条'));
  await tick();
  assert.equal(h.agents.created.length, 1, 'second message must wait for the first');
  assert.equal(h.agents.live.size, 0);

  release();
  await Promise.all([first, second]);
  assert.equal(h.agents.created.length, 1, 'second message reuses the live agent');
  assert.deepEqual(liveAgent(h).followups.map(userMessageText), ['第一条', '第二条']);
});

test('异键并行：不同话题并行创建会话，互不等待', async (t) => {
  const h = makeHarness(t);
  let release!: () => void;
  h.agents.createGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = h.bridge.handleInbound(inbound('A', { threadId: 'omt_a' }));
  const second = h.bridge.handleInbound(inbound('B', { threadId: 'omt_b' }));
  await tick();
  assert.equal(h.agents.created.length, 2, 'both scopes must start in parallel');
  release();
  await Promise.all([first, second]);
  assert.equal(h.agents.created.length, 2);
});

for (const mode of ['queue', 'steer', 'interrupt'] as const) {
  test(`忙时策略 ${mode}：运行中投递走对应通道`, async (t) => {
    const h = makeHarness(t, { busyMode: mode });
    await h.bridge.handleInbound(inbound('第一轮'));
    const agent = liveAgent(h);
    await h.bridge.handleSessionEvent(agent.session, event('turn/start', { turn: 1 }, 1));

    await h.bridge.handleInbound(inbound('忙碌时消息'));
    if (mode !== 'queue') assert.equal(agent.followups.length, 1);
    if (mode === 'queue') {
      assert.equal(agent.followups.length, 2);
      assert.equal(agent.steers.length, 0);
      assert.equal(agent.cancels.length, 0);
      assert.equal(userMessageText(agent.followups[1]!), '忙碌时消息');
    }
    if (mode === 'steer') {
      assert.equal(agent.steers.length, 1);
      assert.equal(agent.cancels.length, 0);
      assert.equal(userMessageText(agent.steers[0]!), '忙碌时消息');
    }
    if (mode === 'interrupt') {
      assert.equal(agent.cancels.length, 1);
      assert.deepEqual(agent.cancels[0], { kind: 'user' });
      assert.equal(agent.steers.length, 1);
    }
  });
}

test('回合收尾：过程卡被 patch，终稿是新消息而非编辑过程卡', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('请回答', { threadId: 'omt_t' }));
  const session = liveAgent(h).session;

  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(session, event('step/start', { turn: 1, step: 1 }, 110));
  await h.bridge.handleSessionEvent(
    session,
    event(
      'assistant/message',
      { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一段' }] } },
      120,
    ),
  );
  h.clock.advance(400);
  await tick();
  await h.bridge.handleSessionEvent(session, event('tool/call', { turn: 1, step: 1 }, 130));
  h.clock.advance(400);
  await tick();
  await h.bridge.handleSessionEvent(session, event('step/end', { turn: 1, step: 1 }, 140));
  h.clock.advance(400);
  await tick();
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );

  const cards = recordedCards(h.transport);
  const titles = cardTitles(cards);
  assert.ok(titles.includes('飞书会话 · 过程'), `process card missing: ${titles.join(', ')}`);
  assert.ok(titles.includes('飞书会话 · 状态'), `status card missing: ${titles.join(', ')}`);

  const progressCard = cards.find((entry) => cardTitles([entry])[0] === '飞书会话 · 过程');
  assert.ok(progressCard !== undefined);
  const progressPatches = patchedCards(h.transport).filter(
    (patch) => patch.messageId === progressCard.messageId,
  );
  assert.ok(progressPatches.length >= 1, 'process card must be updated in place');

  const finalTexts = recordedTexts(h.transport);
  assert.ok(finalTexts.includes('第一段'), 'final answer must be a new text message');
  const finalCall = h.transport.calls.find(
    (call) => call.op === 'reply' && call.payload.kind === 'text' && call.payload.text === '第一段',
  );
  assert.ok(finalCall !== undefined && finalCall.op === 'reply');
  assert.notEqual(finalCall.messageId, progressCard.messageId);
  assert.equal(finalCall.threadId, 'omt_t', 'reply must stay in the topic');
  assert.equal(
    patchedCards(h.transport).filter((patch) => patch.messageId === finalCall.messageId).length,
    0,
    'final message must never be patched as if it were the progress card',
  );
});

for (const [kind, keyword] of [
  ['error', '失败'],
  ['interrupted', '中断'],
  ['blocked', '阻塞'],
] as const) {
  test(`终态 ${kind}：主动推一条消息，无需用户询问`, async (t) => {
    const h = makeHarness(t);
    await h.bridge.handleInbound(inbound('会失败的请求'));
    const session = liveAgent(h).session;
    await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
    await h.bridge.handleSessionEvent(
      session,
      event(
        'turn/end',
        { turn: 1, reason: { kind, ...(kind === 'error' ? { error: { message: 'boom' } } : {}) } },
        200,
      ),
    );
    const texts = recordedTexts(h.transport);
    assert.ok(
      texts.some((text) => text.includes(keyword)),
      `expected a ${kind} notice, got: ${texts.join(' | ')}`,
    );
    // Final answer + proactive notice = two separate outbound messages.
    assert.ok(texts.length >= 2);
  });
}

test('/status 在空闲与运行中两种状态都可读且可区分', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;

  await h.bridge.handleInbound(inbound('/status'));
  const idle = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(idle, /等待输入/);
  assert.match(idle, /步数：0/);

  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));
  await h.bridge.handleSessionEvent(session, event('step/start', { turn: 1, step: 1 }, 1_100));
  await h.bridge.handleInbound(inbound('/status'));
  const running = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(running, /运行中/);
  assert.match(running, /步数：1/);
  assert.notEqual(running, idle);
});

test('/stop 调 agent.cancel({kind:user})', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('跑起来'));
  const agent = liveAgent(h);
  await h.bridge.handleSessionEvent(agent.session, event('turn/start', { turn: 1 }, 1));
  await h.bridge.handleInbound(inbound('/stop'));
  assert.equal(agent.cancels.length, 1);
  assert.deepEqual(agent.cancels[0], { kind: 'user' });
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已请求停止/);
});

test('/new 铸新会话，/resume 恢复上一会话', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('第一轮'));
  const key = scopeKey('oc_chat');
  const firstSession = h.store.get(key);
  assert.ok(firstSession !== undefined);

  await h.bridge.handleInbound(inbound('/new'));
  const secondSession = h.store.get(key);
  assert.ok(secondSession !== undefined);
  assert.notEqual(secondSession, firstSession);

  await h.bridge.handleInbound(inbound('/resume'));
  assert.equal(h.store.get(key), firstSession);
  assert.ok(h.agents.resumed.includes(firstSession as string));
});

test('/rename 成功与 SessionTitleInvalidError 翻译', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const sessionId = liveAgent(h).session.id;

  await h.bridge.handleInbound(inbound('/rename 新标题'));
  assert.deepEqual(h.titles.renamed.at(-1), { sessionId, title: '新标题' });
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已重命名：新标题/);

  h.titles.invalidTitles.add('坏标题');
  await h.bridge.handleInbound(inbound('/rename 坏标题'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /标题不能为空或太短/);
});

test('未知命令：denylist 拒绝 /export，其余转交命令注册表', async (t) => {
  const forwarded: string[] = [];
  const h = makeHarness(t, {
    commandRunner: async (_agent, line) => {
      forwarded.push(line);
      if (line === '/compact') return { kind: 'success', text: '压缩完成' };
      return undefined;
    },
  });

  await h.bridge.handleInbound(inbound('/export'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /仅 Web/);
  assert.deepEqual(forwarded, [], 'denylisted commands must not reach the registry');

  await h.bridge.handleInbound(inbound('/compact'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /压缩完成/);
  assert.deepEqual(forwarded, ['/compact']);

  await h.bridge.handleInbound(inbound('/nope x'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /未知命令/);
});

test('/help 覆盖全部自有命令（含 /status）', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('/help'));
  const help = recordedTexts(h.transport).at(-1) ?? '';
  for (const name of ['/new', '/sessions', '/rename', '/resume', '/stop', '/status', '/persona', '/help']) {
    assert.ok(help.includes(name), `help is missing ${name}`);
  }
});

test('/persona 调用注入的共享处理器', async (t) => {
  const actions: string[] = [];
  const h = makeHarness(t, {
    persona: async (action) => {
      actions.push(action);
      return { kind: 'success', text: `persona ${action} ok` };
    },
  });
  await h.bridge.handleInbound(inbound('/persona sync'));
  assert.deepEqual(actions, ['sync']);
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /persona sync ok/);
});

test('允许列表：不在允许 chat 的消息被忽略', async (t) => {
  const h = makeHarness(t, { allowedChats: ['oc_allowed'] });
  await h.bridge.handleInbound(inbound('被忽略'));
  assert.equal(h.agents.created.length, 0);
  assert.equal(h.store.keys().length, 0);

  await h.bridge.handleInbound(inbound('放行', { chatId: 'oc_allowed' }));
  assert.equal(h.agents.created.length, 1);
});

test('resume 失败时重铸新 session，不让聊天永久卡死', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('第一轮'));
  const key = scopeKey('oc_chat');
  const firstSession = h.store.get(key) as string;

  // Force the mapped session to look stale: drop the live agent and fail resume.
  h.agents.live.clear();
  h.agents.failResume.add(firstSession);

  await h.bridge.handleInbound(inbound('第二轮'));
  const reminted = h.store.get(key);
  assert.ok(reminted !== undefined);
  assert.notEqual(reminted, firstSession);
  assert.equal(h.agents.created.length, 2);
  assert.equal(liveAgent(h).followups.length, 1);
});

test('无关 session 的事件被忽略', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleSessionEvent({ id: 'someone-else' }, event('turn/start', { turn: 1 }, 1));
  assert.equal(h.transport.calls.length, 0);
});

test('@ 门禁：p2p 不需要 @', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(inbound('私聊消息'));
  assert.equal(liveAgent(h).followups.length, 1);
});

test('@ 门禁：群普通消息没有 @机器人 → 静默丢弃，不建会话', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(inbound('群里没 @', { chatType: 'group' }));
  assert.equal(h.agents.created.length, 0);
  assert.equal(h.store.keys().length, 0);
  assert.equal(h.transport.calls.length, 0);
});

test('@ 门禁：群里 @ 其他用户不算 @ 机器人', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(
    inbound('@别人 看看', { chatType: 'group', mentions: ['ou_other'] }),
  );
  assert.equal(h.agents.created.length, 0);
  assert.equal(h.transport.calls.length, 0);
});

test('@ 门禁：群里 @ 机器人通过', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(
    inbound('@机器人 你好', { chatType: 'group', mentions: ['ou_bot'] }),
  );
  assert.equal(liveAgent(h).followups.length, 1);
});

test('话题豁免：已绑定话题的群消息免 @（继续对话）', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot', prebindTopic: true });
  await h.bridge.handleInbound(
    inbound('话题内继续', { chatType: 'group', threadId: 'omt_t' }),
  );
  assert.equal(h.agents.resumed.length, 1, 'bound topic must resume, not create');
  assert.equal(liveAgent(h).followups.length, 1);
});

test('话题语义：新话题首条仍需 @，加 @ 后才建档', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(
    inbound('新话题首条无 @', { chatType: 'group', threadId: 'omt_new' }),
  );
  assert.equal(h.agents.created.length, 0);
  assert.equal(h.store.keys().length, 0);

  await h.bridge.handleInbound(
    inbound('@机器人 新话题', {
      chatType: 'group',
      threadId: 'omt_new',
      mentions: ['ou_bot'],
    }),
  );
  assert.equal(liveAgent(h).followups.length, 1);
});

test('@ 门禁：bot open id 未知时，带 mention 的群消息放行（避免全丢）', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(
    inbound('@某人', { chatType: 'group', mentions: ['ou_anyone'] }),
  );
  assert.equal(liveAgent(h).followups.length, 1);
});

test('状态卡标题时序：session/title 到达后就地重渲染，不新增 message_id', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));

  const before = recordedCards(h.transport);
  const statusCard = before.find(
    (entry) => entry.card.header?.title.content === '飞书会话 · 状态',
  );
  assert.ok(statusCard !== undefined);
  assert.match(JSON.stringify(statusCard.card), /标题生成中/);
  assert.ok(!JSON.stringify(statusCard.card).includes('（无标题）'));

  h.clock.advance(400);
  await tick();
  await h.bridge.handleSessionEvent(session, {
    type: 'session/title',
    data: { title: '真实标题', source: { kind: 'fallback' }, messageSeqs: [] },
    time: 1_100,
  });
  h.clock.advance(400);
  await tick();

  assert.equal(
    recordedCards(h.transport).length,
    before.length,
    'title arrival must not create a new status card',
  );
  const patches = patchedCards(h.transport).filter(
    (patch) => patch.messageId === statusCard.messageId,
  );
  assert.ok(patches.length >= 1, 'status card must be patched in place');
  assert.match(JSON.stringify(patches.at(-1)?.card), /真实标题/);

  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /真实标题/);
});

test('标题先到：状态卡首次渲染即用标题，不写「标题生成中」', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  const callsBefore = h.transport.calls.length;

  await h.bridge.handleSessionEvent(session, {
    type: 'session/title',
    data: { title: '早到标题' },
    time: 1,
  });
  assert.equal(h.transport.calls.length, callsBefore, 'no message before the status card exists');

  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 2));
  const statusCard = recordedCards(h.transport).find(
    (entry) => entry.card.header?.title.content === '飞书会话 · 状态',
  );
  assert.ok(statusCard !== undefined);
  assert.match(JSON.stringify(statusCard.card), /早到标题/);
  assert.ok(!JSON.stringify(statusCard.card).includes('标题生成中'));
});
