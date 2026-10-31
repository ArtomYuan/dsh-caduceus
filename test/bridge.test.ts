/**
 * Bridge tests: per-scope serialization, cross-scope parallelism, busy modes,
 * final-answer-as-new-message, terminal notices, command dispatch, and agent
 * resolution failure recovery.
 *
 * Every test injects fake transport/agents/title/clock; session state lives in
 * a `mkdtemp` directory and is deleted afterwards.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { Bridge } from '../src/bridge/bridge.js';
import type { AgentLike, BridgeConfig, BusyMode, SessionTitleLike } from '../src/bridge/types.js';
import type { HarnessCommandResult } from '../src/commands/harness.js';
import { scopeKey, SESSION_MAP_VERSION, SessionStore } from '../src/session-key.js';
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
  /** Seed a legacy v3 session-map before the bridge loads it. */
  readonly seedMap?: Readonly<Record<string, string>>;
  /** Ordinary-group isolation switch (default true). */
  readonly groupSessionsPerUser?: boolean;
  /** Deferred title service (lazy-resolution tests); overrides `title`. */
  readonly titleProvider?: () => SessionTitleLike | undefined;
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
  const mapPath = join(dir, 'session-map.json');
  if (options.seedMap !== undefined) {
    writeFileSync(
      mapPath,
      JSON.stringify({
        version: 3,
        entries: Object.fromEntries(
          Object.entries(options.seedMap).map(([key, sessionId]) => [key, { sessionId }]),
        ),
        cwd: {},
      }),
      'utf8',
    );
  }
  const store = new SessionStore({
    filePath: mapPath,
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
    groupSessionsPerUser: options.groupSessionsPerUser ?? true,
  };
  if (options.prebindTopic === true) {
    store.set(scopeKey('group', 'oc_chat', 'omt_t', 'ou_user'), 'feishu-prebound-1');
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
    ...(options.titleProvider === undefined
      ? { sessionTitle: titles }
      : { sessionTitleProvider: options.titleProvider }),
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
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  let release!: () => void;
  h.agents.createGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = h.bridge.handleInbound(
    inbound('A', { chatType: 'group', threadId: 'omt_a', mentions: ['ou_bot'] }),
  );
  const second = h.bridge.handleInbound(
    inbound('B', { chatType: 'group', threadId: 'omt_b', mentions: ['ou_bot'] }),
  );
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
  assert.match(idle, /空闲/);
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
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
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
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
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

test('群内话题（已绑定会话）仍需 @：无 @ 丢弃，不再免 @', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot', prebindTopic: true });
  await h.bridge.handleInbound(
    inbound('话题内继续（无 @）', { chatType: 'group', threadId: 'omt_t' }),
  );
  assert.equal(h.agents.resumed.length, 0, 'bound topic must NOT bypass the @ gate');
  assert.equal(h.agents.created.length, 0);
  assert.equal(h.transport.calls.length, 0);
  assert.ok(
    h.logger.entries.some((entry) => entry.message.startsWith('gate drop: no-mention ')),
    'a debug line must record the dropped group message',
  );
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

test('群内话题（已绑定会话）加上 @ 机器人后正常处理', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot', prebindTopic: true });
  await h.bridge.handleInbound(
    inbound('@机器人 话题内继续', {
      chatType: 'group',
      threadId: 'omt_t',
      mentions: ['ou_bot'],
    }),
  );
  assert.equal(h.agents.resumed.length, 1);
  assert.equal(liveAgent(h).followups.length, 1);
});

test('agent 就绪后强制重渲状态卡：同一 message_id 且带上标题', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));

  const statusCard = recordedCards(h.transport).find(
    (entry) => entry.card.header?.title.content === '飞书会话 · 状态',
  );
  assert.ok(statusCard !== undefined);
  assert.match(JSON.stringify(statusCard.card), /标题生成中/);

  // The title appears in the service only after the first render (the real
  // failure mode: title events arrived before this bridge bound the session).
  h.titles.titles.set(String(session.id), '服务端标题');
  h.clock.advance(400);
  await tick();
  const cardCountBefore = recordedCards(h.transport).length;

  // Any resolution path ends in create/resume returning → force one re-render.
  await h.bridge.handleInbound(inbound('继续问一句'));
  h.clock.advance(400);
  await tick();

  assert.equal(
    recordedCards(h.transport).length,
    cardCountBefore,
    'agent-ready refresh must reuse the same card, not send a new one',
  );
  const patches = patchedCards(h.transport).filter(
    (patch) => patch.messageId === statusCard.messageId,
  );
  assert.ok(patches.length >= 1, 'existing status card must be patched');
  assert.match(JSON.stringify(patches.at(-1)?.card), /服务端标题/);
  const firstLine = patches.at(-1)?.card.elements[0]?.text?.content;
  assert.equal(firstLine, '会话：服务端标题', 'status card keeps `会话：{title}` as its first line');
});

test('/sessions 行格式：▸ 标题 · 相对时间 · sessionId 后 8 位', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_700_000_000_000));
  h.titles.titles.set(String(session.id), '会话标题');
  h.clock.advance(400);
  await tick();

  await h.bridge.handleInbound(inbound('/sessions'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /^\* ▸ 会话标题 · 刚刚 · [a-z0-9-]{8}$/m, text);
  assert.ok(text.includes(String(session.id).slice(-8)), text);
  assert.ok(!text.includes(String(session.id)), 'full sessionId must not be printed');
  assert.equal(text.split('\n').at(-1), '用 /rename <标题> 改当前会话名');
});

test('/sessions 标题为空时显示「（未命名）」而不是空白', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_700_000_000_000));

  await h.bridge.handleInbound(inbound('/sessions'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /^\* ▸ （未命名） · 刚刚 · [a-z0-9-]{8}$/m, text);
});

test('终稿带标题：首行 `▸ 标题` + 空行 + 完整正文', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  h.titles.titles.set(String(session.id), '会话标题');
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));
  await h.bridge.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '正文内容' }] } },
    time: 1_100,
  });
  await h.bridge.handleSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    time: 1_200,
  });

  const final = h.transport.calls.find(
    (call) => call.op === 'reply' && call.payload.kind === 'text' && call.payload.text.includes('正文内容'),
  );
  assert.ok(final !== undefined && final.op === 'reply' && final.payload.kind === 'text');
  assert.equal(final.payload.text, '▸ 会话标题\n\n正文内容');
});

test('终稿无标题：没有 `▸` 首行，也不出现「未命名」', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));
  await h.bridge.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '正文内容' }] } },
    time: 1_100,
  });
  await h.bridge.handleSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    time: 1_200,
  });

  const final = h.transport.calls.find(
    (call) => call.op === 'reply' && call.payload.kind === 'text' && call.payload.text.includes('正文内容'),
  );
  assert.ok(final !== undefined && final.op === 'reply' && final.payload.kind === 'text');
  assert.equal(final.payload.text, '正文内容');
  assert.ok(!final.payload.text.startsWith('▸'));
  assert.ok(!final.payload.text.includes('未命名'));
});

test('/sessions 多会话：当前行标记、相对时间排序、只列本 scopeKey', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(inbound('A'));
  const agentA = liveAgent(h);
  await h.bridge.handleSessionEvent(agentA.session, event('turn/start', { turn: 1 }, 0));
  h.titles.titles.set(String(agentA.session.id), '标题一');
  h.clock.advance(5 * 60 * 1000);

  // A session in another scope must never leak into this list.
  await h.bridge.handleInbound(
    inbound('别的话题', { chatType: 'group', threadId: 'omt_other', mentions: ['ou_bot'] }),
  );
  const otherAgent = [...h.agents.live.values()].find(
    (agent) => String(agent.session.id) !== String(agentA.session.id),
  );
  assert.ok(otherAgent !== undefined);
  h.titles.titles.set(String(otherAgent.session.id), '别的话题标题');

  await h.bridge.handleInbound(inbound('/new'));
  await h.bridge.handleInbound(inbound('B'));
  const currentSessionId = h.store.get(scopeKey('p2p', 'oc_chat', null, 'ou_user')) as string;
  const agentB = h.agents.live.get(currentSessionId);
  assert.ok(agentB !== undefined);
  await h.bridge.handleSessionEvent(
    agentB.session,
    event('turn/start', { turn: 1 }, h.clock.now()),
  );
  h.titles.titles.set(currentSessionId, '标题二');
  h.clock.advance(1_000);

  await h.bridge.handleInbound(inbound('/sessions'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  const lines = text.split('\n');
  const currentLine = lines.find((line) => line.startsWith('* ▸ '));
  const previousLine = lines.find((line) => line.startsWith('▸ ') && !line.startsWith('* '));
  assert.ok(currentLine !== undefined, text);
  assert.ok(previousLine !== undefined, text);
  assert.ok(currentLine.includes('标题二'), text);
  assert.ok(previousLine.includes('标题一'), text);
  assert.ok(lines.indexOf(currentLine) < lines.indexOf(previousLine), 'current session first');
  assert.match(currentLine, /^\* ▸ 标题二 · 刚刚 · [a-z0-9-]{8}$/);
  assert.match(previousLine, /^▸ 标题一 · 5 分钟前 · [a-z0-9-]{8}$/);
  assert.ok(!text.includes('别的话题标题'), 'cross-scope session must not be listed');
  assert.equal(lines.at(-1), '用 /rename <标题> 改当前会话名');
});

test('Hermes 键：私聊同 chat 两个 sender → 同键、同一会话', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('A 用户', { chatType: 'p2p', senderOpenId: 'ou_a' }));
  await h.bridge.handleInbound(inbound('B 用户', { chatType: 'p2p', senderOpenId: 'ou_b' }));
  assert.equal(h.store.keys().length, 1);
  assert.equal(h.agents.created.length, 1);
  assert.equal(liveAgent(h).followups.length, 2);
});

test('Hermes 键：普通群两个 sender → 不同键、不同 sessionId（按人隔离）', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(
    inbound('A 说', { chatType: 'group', senderOpenId: 'ou_a', mentions: ['ou_bot'] }),
  );
  await h.bridge.handleInbound(
    inbound('B 说', { chatType: 'group', senderOpenId: 'ou_b', mentions: ['ou_bot'] }),
  );
  const keyA = scopeKey('group', 'oc_chat', null, 'ou_a');
  const keyB = scopeKey('group', 'oc_chat', null, 'ou_b');
  assert.notEqual(keyA, keyB);
  assert.deepEqual(h.store.keys().sort(), [keyA, keyB].sort());
  const sessionA = h.store.get(keyA);
  const sessionB = h.store.get(keyB);
  assert.ok(sessionA !== undefined && sessionB !== undefined);
  assert.notEqual(sessionA, sessionB);
  assert.equal(h.agents.created.length, 2);
  assert.equal(h.agents.live.get(sessionA)?.followups.length, 1);
  assert.equal(h.agents.live.get(sessionB)?.followups.length, 1);
});

test('Hermes 键：群内话题两个 sender → 同键、共享同一会话', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(
    inbound('A 在话题里说', {
      chatType: 'group',
      threadId: 'omt_t',
      senderOpenId: 'ou_a',
      mentions: ['ou_bot'],
    }),
  );
  await h.bridge.handleInbound(
    inbound('B 在话题里说', {
      chatType: 'group',
      threadId: 'omt_t',
      senderOpenId: 'ou_b',
      mentions: ['ou_bot'],
    }),
  );
  const topicKey = scopeKey('group', 'oc_chat', 'omt_t', 'ou_a');
  assert.equal(topicKey, scopeKey('group', 'oc_chat', 'omt_t', 'ou_b'));
  assert.deepEqual(h.store.keys(), [topicKey]);
  assert.equal(h.agents.created.length, 1);
  assert.equal(liveAgent(h).followups.length, 2);
});

test('v3 旧共享条目原样保留，新消息落 per-user 新键（v4）', async (t) => {
  const legacyKey = 'oc_chat\u0000omt_legacy';
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: { [legacyKey]: 'feishu-legacy-shared' },
  });
  assert.equal(h.store.get(legacyKey), 'feishu-legacy-shared');

  await h.bridge.handleInbound(
    inbound('群里说话', { chatType: 'group', senderOpenId: 'ou_a', mentions: ['ou_bot'] }),
  );
  const newKey = scopeKey('group', 'oc_chat', null, 'ou_a');
  const newSession = h.store.get(newKey);
  assert.ok(newSession !== undefined);
  assert.notEqual(newSession, 'feishu-legacy-shared');
  assert.equal(h.store.get(legacyKey), 'feishu-legacy-shared', 'legacy key must not be rewritten');

  const persisted = JSON.parse(readFileSync(join(h.dir, 'session-map.json'), 'utf8')) as {
    version: number;
    entries: Record<string, { sessionId: string }>;
  };
  assert.equal(persisted.version, SESSION_MAP_VERSION);
  assert.deepEqual(persisted.entries[legacyKey], { sessionId: 'feishu-legacy-shared' });
  assert.deepEqual(persisted.entries[newKey], { sessionId: newSession });
});

test('/sessions --all：同 chat 混合旧键/话题键/用户键全部列出且标签正确', async (t) => {
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: {
      oc_chat: 'feishu-legacy-01',
      'oc_chat\u0000omt_oldtopic123': 'feishu-topic-01',
      'oc_chat\u0000ou_otheruser123': 'feishu-user-01',
      oc_other: 'feishu-otherchat',
    },
  });
  await h.bridge.handleInbound(
    inbound('hi', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  const session = liveAgent(h).session;
  h.titles.titles.set(String(session.id), '我的会话');
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 0));

  await h.bridge.handleInbound(
    inbound('/sessions --all', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  const text = recordedTexts(h.transport).at(-1) ?? '';
  const lines = text.split('\n');
  assert.match(lines[0] as string, /本聊天下的会话/);
  const currentLine = lines.find((line) => line.startsWith('* ▸ '));
  assert.ok(currentLine !== undefined, text);
  assert.match(currentLine, /^\* ▸ 我的会话 · (刚刚|\d+ 分钟前) · [a-z0-9-]{8} · 用户 ou_me$/);
  assert.ok(lines.some((line) => /egacy-01 · 旧会话$/.test(line)), text);
  assert.ok(lines.some((line) => /topic-01 · 话题 omt_oldt$/.test(line)), text);
  assert.ok(lines.some((line) => /-user-01 · 用户 ou_other$/.test(line)), text);
  assert.equal(lines.at(-1), '用 /resume <id 后 8 位> 继续某条会话');
  assert.ok(!text.includes('herchat'), 'other chat sessions must not be listed');
  assert.equal(lines.length, 6, text); // header + 4 sessions + hint
});

test('/sessions 不带参数：只列当前 scopeKey，不出现其他 scope 的会话', async (t) => {
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: {
      oc_chat: 'feishu-legacy-01',
      'oc_chat\u0000omt_oldtopic123': 'feishu-topic-01',
      'oc_chat\u0000ou_otheruser123': 'feishu-user-01',
    },
  });
  await h.bridge.handleInbound(
    inbound('hi', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  await h.bridge.handleInbound(
    inbound('/sessions', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  const text = recordedTexts(h.transport).at(-1) ?? '';
  const currentId = h.store.get(
    scopeKey('group', 'oc_chat', null, 'ou_me'),
  ) as string;
  assert.ok(text.includes(currentId.slice(-8)), text);
  assert.ok(!text.includes('egacy-01'), text);
  assert.ok(!text.includes('topic-01'), text);
  assert.ok(!text.includes('-user-01'), text);
  assert.equal(text.split('\n').at(-1), '用 /rename <标题> 改当前会话名');
});

test('/resume 前缀：唯一命中时切换到该会话', async (t) => {
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: { 'oc_chat\u0000omt_oldtopic123': 'feishu-unique-1234' },
  });
  await h.bridge.handleInbound(
    inbound('hi', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  const currentKey = scopeKey('group', 'oc_chat', null, 'ou_me');
  const before = h.store.get(currentKey);
  assert.notEqual(before, 'feishu-unique-1234');

  const tail = 'feishu-unique-1234'.slice(-8);
  await h.bridge.handleInbound(
    inbound(`/resume ${tail}`, { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  assert.equal(h.store.get(currentKey), 'feishu-unique-1234');
  assert.ok(h.agents.resumed.includes('feishu-unique-1234'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已恢复会话 feishu-unique-1234/);
});

test('/resume 前缀：多条命中时给歧义提示且不切换', async (t) => {
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: {
      'oc_chat\u0000omt_ambig1111': 'feishu-ambig-11111111',
      'oc_chat\u0000ou_ambig2222': 'feishu-other-11111111',
    },
  });
  await h.bridge.handleInbound(
    inbound('hi', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  const currentKey = scopeKey('group', 'oc_chat', null, 'ou_me');
  const before = h.store.get(currentKey);

  await h.bridge.handleInbound(
    inbound('/resume 11111111', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /命中 2 条会话/);
  assert.ok(text.includes('11111111'));
  assert.equal(h.store.get(currentKey), before, 'ambiguous prefix must not switch');
});

test('/resume：零命中与过短前缀都给出明确提示', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const currentKey = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const before = h.store.get(currentKey);

  await h.bridge.handleInbound(inbound('/resume 99999999'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /没找到匹配的会话/);

  await h.bridge.handleInbound(inbound('/resume feishu'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /尾号至少 8 位/);
  assert.equal(h.store.get(currentKey), before);
});

test('groupSessionsPerUser=false：普通群两个 sender 回退为同键共享', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot', groupSessionsPerUser: false });
  await h.bridge.handleInbound(
    inbound('A 说', { chatType: 'group', senderOpenId: 'ou_a', mentions: ['ou_bot'] }),
  );
  await h.bridge.handleInbound(
    inbound('B 说', { chatType: 'group', senderOpenId: 'ou_b', mentions: ['ou_bot'] }),
  );
  assert.equal(h.store.keys().length, 1);
  assert.equal(h.store.keys()[0], 'oc_chat');
  assert.equal(h.agents.created.length, 1);
  assert.equal(liveAgent(h).followups.length, 2);
});

test('/sessions --all：p2p 当前会话的 scope 标签为「私聊」', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/sessions --all'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  const currentLine = text.split('\n').find((line) => line.startsWith('* ▸ '));
  assert.ok(currentLine !== undefined, text);
  assert.match(currentLine, / · 私聊$/);
  assert.equal(text.split('\n').at(-1), '用 /resume <id 后 8 位> 继续某条会话');
});

test('命令分发日志：owned / unknown passthrough / parse-fail', async (t) => {
  const h = makeHarness(t, { commandRunner: async () => undefined });
  await h.bridge.handleInbound(inbound('/status'));
  await h.bridge.handleInbound(inbound('/compact'));
  await h.bridge.handleInbound(inbound('/'));

  const messages = h.logger.entries.map((entry) => entry.message);
  assert.ok(messages.includes('command: /status'), messages.join(' | '));
  assert.ok(
    messages.some((message) => message.startsWith('command: unknown passthrough /compact')),
    messages.join(' | '),
  );
  assert.ok(
    messages.some((message) => message.startsWith('command: parse-fail /')),
    messages.join(' | '),
  );
});

test('scope 日志：p2p/群话题/群用户三种 kind 各一行', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(inbound('hi', { chatType: 'p2p', senderOpenId: 'ou_dm' }));
  await h.bridge.handleInbound(
    inbound('topic', {
      chatType: 'group',
      threadId: 'omt_topic123456',
      senderOpenId: 'ou_a',
      mentions: ['ou_bot'],
    }),
  );
  await h.bridge.handleInbound(
    inbound('group', { chatType: 'group', senderOpenId: 'ou_b', mentions: ['ou_bot'] }),
  );

  const scopeLines = h.logger.entries
    .map((entry) => entry.message)
    .filter((message) => message.startsWith('scope: '));
  assert.ok(scopeLines.some((line) => /^scope: kind=p2p key=oc_chat session=[a-z0-9-]{8}$/.test(line)), scopeLines.join(' | '));
  assert.ok(scopeLines.some((line) => line.startsWith('scope: kind=topic key=oc_chat\\0omt_to')));
  assert.ok(scopeLines.some((line) => line.startsWith('scope: kind=group-user key=oc_chat\\0ou_b')));
});

test('门禁日志：p2p 接受 / 群无 @ 丢弃都带 chat/thread/sender 前缀', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(inbound('hi', { chatType: 'p2p', senderOpenId: 'ou_dm' }));
  await h.bridge.handleInbound(
    inbound('群消息', { chatType: 'group', threadId: 'omt_t', senderOpenId: 'ou_x' }),
  );
  const gateLines = h.logger.entries
    .map((entry) => entry.message)
    .filter((message) => message.startsWith('gate '));
  assert.ok(gateLines.some((line) => line.startsWith('gate accept: p2p ')));
  assert.ok(gateLines.some((line) => line.startsWith('gate drop: no-mention ')));
  for (const line of gateLines) {
    assert.match(line, /chat=oc_chat thread=(omt_t|-)?.*sender=ou_/);
  }
});

test('sessionTitle 惰性解析：服务晚挂载后 /rename /sessions /status 都可用', async (t) => {
  const titles = new FakeTitleService();
  let mounted: FakeTitleService | undefined;
  const h = makeHarness(t, { titleProvider: () => mounted });
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  titles.titles.set(String(session.id), '晚挂载标题');

  // Before mount: no crash, no title (status card/reply says 标题生成中).
  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /标题生成中/);

  mounted = titles;
  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /晚挂载标题/);
  await h.bridge.handleInbound(inbound('/sessions'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /晚挂载标题/);
  await h.bridge.handleInbound(inbound('/rename 新标题'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已重命名：新标题/);
  assert.deepEqual(titles.renamed.at(-1), {
    sessionId: String(session.id),
    title: '新标题',
  });
});

test('/resume 支持完整 sessionId（chat 内任意 scope）', async (t) => {
  const target = 'feishu-1793460837083';
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: { 'oc_chat\u0000omt_full': target },
  });
  const command = (text: string) =>
    inbound(text, { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] });
  await h.bridge.handleInbound(command('hi'));
  const key = scopeKey('group', 'oc_chat', null, 'ou_me');
  assert.notEqual(h.store.get(key), target);

  await h.bridge.handleInbound(command(`/resume ${target}`));
  assert.equal(h.store.get(key), target);
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已恢复会话 feishu-1793460837083/);
});

test('/sessions --all：时间从 feishu-<epoch_ms> 解析，非法 id 显示 —，展示尾 8 位', async (t) => {
  const now = Date.parse('2026-10-31T23:00:00Z');
  const fiveMin = now - 5 * 60 * 1000;
  const twoHours = now - 2 * 60 * 60 * 1000;
  const threeDays = now - 3 * 24 * 60 * 60 * 1000;
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: {
      'oc_chat\u0000omt_5m': `feishu-${fiveMin}`,
      'oc_chat\u0000omt_2h': `feishu-${twoHours}`,
      'oc_chat\u0000ou_3d': `feishu-${threeDays}`,
      'oc_chat\u0000ou_bad': 'feishu-not-a-timestamp',
    },
  });
  h.clock.advance(now);
  const command = (text: string) =>
    inbound(text, { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] });
  await h.bridge.handleInbound(command('hi'));
  await h.bridge.handleInbound(command('/sessions --all'));

  const lines = (recordedTexts(h.transport).at(-1) ?? '').split('\n');
  const lineFor = (id: string) => lines.find((line) => line.includes(id.slice(-8)));
  const line5m = lineFor(`feishu-${fiveMin}`);
  const line2h = lineFor(`feishu-${twoHours}`);
  const line3d = lineFor(`feishu-${threeDays}`);
  const lineBad = lineFor('feishu-not-a-timestamp');
  assert.ok(line5m !== undefined);
  assert.ok(line2h !== undefined);
  assert.ok(line3d !== undefined);
  assert.ok(lineBad !== undefined);
  assert.match(line5m, / · 5 分钟前 · /);
  assert.match(line2h, / · 2 小时前 · /);
  assert.match(line3d, / · 10-28 23:00 · /);
  assert.match(lineBad, / · — · /);
});
