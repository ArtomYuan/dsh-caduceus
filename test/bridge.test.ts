/**
 * Bridge tests: per-scope serialization, cross-scope parallelism, busy modes,
 * final-answer-as-new-message, terminal notices, command dispatch, and agent
 * resolution failure recovery.
 *
 * Every test injects fake transport/agents/title/clock; session state lives in
 * a `mkdtemp` directory and is deleted afterwards.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { Bridge } from '../src/bridge/bridge.js';
import type {
  AgentLike,
  ApprovalPolicy,
  ApprovalServiceLike,
  BridgeConfig,
  BusyMode,
  SessionTitleLike,
} from '../src/bridge/types.js';
import type { HarnessCommandResult } from '../src/commands/harness.js';
import { scopeKey, SESSION_MAP_VERSION, SessionStore } from '../src/session-key.js';
import type { StatusEventLike } from '../src/status.js';
import { CARD_BYTE_LIMIT, cardByteSize } from '../src/render/cards.js';
import type { FeishuCard, InboundMessage } from '../src/transport/types.js';
import {
  FakeAgent,
  FakeAgentPresets,
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
  /** Seed a v5 session-map (current + history) before the bridge loads it. */
  readonly seedV5?: Readonly<
    Record<string, { readonly sessionId: string; readonly history: readonly string[] }>
  >;
  /** Ordinary-group isolation switch (default true). */
  readonly groupSessionsPerUser?: boolean;
  /** Deferred title service (lazy-resolution tests); overrides `title`. */
  readonly titleProvider?: () => SessionTitleLike | undefined;
  /** Disk-existence predicate for /sessions ghost markers (default: true). */
  readonly sessionExists?: (sessionId: string) => boolean;
  /** Caduceus session ids discoverable on disk for /adopt (default: none). */
  readonly sessionIdsProvider?: () => readonly string[];
  /** Agent preset double; null means the optional service is unavailable. */
  readonly agentPresets?: FakeAgentPresets | null;
  /** Lazy preset provider (overrides `agentPresets`) for late-registration tests. */
  readonly agentPresetsProvider?: () => FakeAgentPresets | undefined;
  /** Configured preset id (default `standard`). */
  readonly agentPreset?: string;
  /** Persistent session-header preset lookup (simulates a non-legacy header). */
  readonly sessionPresetLookup?: (sessionId: string) => string | undefined;
  /** Self-check controller (for /status and /selfcheck tests). */
  readonly selfCheck?: import('../src/selfcheck.js').SelfChecker;
  /** Interactive approval/question runtime (optional). */
  readonly interactive?: import('../src/interactive/runtime.js').InteractiveRuntime;
  /** Approval service double; undefined means the service is missing. */
  readonly approvalProvider?: () => ApprovalServiceLike | undefined;
  /** Session approval policy override (bridge default `ask`). */
  readonly approvalPolicy?: ApprovalPolicy;
  /** Plugin root context double for interactive registration. */
  readonly rootCtx?: unknown;
  /** `/doctor` data collector (optional; tests inject deterministic data). */
  readonly doctorInputs?: (
    session: import('../src/doctor.js').DoctorSessionInfo,
  ) => import('../src/doctor.js').DoctorInputs | Promise<import('../src/doctor.js').DoctorInputs>;
}

interface Harness {
  readonly dir: string;
  readonly store: SessionStore;
  readonly presets: FakeAgentPresets | undefined;
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
  if (options.seedV5 !== undefined) {
    writeFileSync(
      mapPath,
      JSON.stringify({ version: 5, entries: options.seedV5, cwd: {} }),
      'utf8',
    );
  } else if (options.seedMap !== undefined) {
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
    ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
  };
  // Ownership sidecars must never escape into the real ~/.dsh during tests.
  const ownershipDir = join(dir, 'owners');
  const sessionIdsProvider = options.sessionIdsProvider ?? (() => []);
  const agentPresets =
    options.agentPresets === null ? undefined : (options.agentPresets ?? new FakeAgentPresets());
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
    ...(options.sessionExists === undefined ? {} : { sessionExists: options.sessionExists }),
    ownershipDir,
    sessionIdsProvider,
    ...(options.agentPresetsProvider !== undefined
      ? { agentPresetsProvider: options.agentPresetsProvider }
      : agentPresets === undefined
        ? {}
        : { agentPresets }),
    ...(options.sessionPresetLookup === undefined
      ? {}
      : { sessionPresetLookup: options.sessionPresetLookup }),
    ...(options.selfCheck === undefined ? {} : { selfCheck: options.selfCheck }),
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
    ...(options.rootCtx === undefined ? {} : { rootCtx: options.rootCtx }),
    ...(options.approvalProvider === undefined
      ? {}
      : { approvalProvider: options.approvalProvider }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.doctorInputs === undefined ? {} : { doctorInputs: options.doctorInputs }),
  });
  return { dir, store, presets: agentPresets, transport, agents, clock, logger, titles, bridge };
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

const PROCESS_CARD_TITLE = '飞书会话 · 过程';

function cardOfTitle(
  cards: { readonly messageId: string; readonly card: FeishuCard }[],
  title: string,
): { readonly messageId: string; readonly card: FeishuCard } | undefined {
  return cards.find((entry) => entry.card.header?.title.content === title);
}

function finalPatchOfCard(
  transport: FakeTransport,
  messageId: string,
): FeishuCard | undefined {
  return patchedCards(transport).filter((patch) => patch.messageId === messageId).at(-1)?.card;
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

test('回合收尾：编辑同一张过程卡到终态，不另发文本', async (t) => {
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
  const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined, 'one process card per turn');
  assert.equal(cards.length, 1, 'exactly one card per turn (no status card)');

  const finalJson = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.match(finalJson, /第一段/, 'final process card carries the complete answer');
  assert.match(finalJson, /完成/);

  assert.equal(recordedTexts(h.transport).length, 0, 'no final text message may be sent');
  assert.equal(
    h.transport.calls.filter((call) => call.op === 'sendText').length,
    0,
    'sendText is reserved for the fallback path',
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
    assert.equal(texts.length, 1, 'answer lives in the card; only the notice is text');
    assert.ok(
      texts.some((text) => text.includes(keyword)),
      `expected a ${kind} notice, got: ${texts.join(' | ')}`,
    );
    const cards = recordedCards(h.transport);
    const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
    assert.ok(processCard !== undefined, 'answer card still exists');
    const cardText = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
    assert.ok(
      /失败|已中断|待审批/.test(cardText),
      `final card must show the terminal state: ${cardText}`,
    );
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
  const warning = h.logger.entries.find(
    (entry) => entry.level === 'warn' && entry.message.includes('never landed'),
  );
  assert.ok(warning !== undefined, h.logger.entries.map((entry) => entry.message).join(' | '));
  assert.ok(warning.message.includes(firstSession), warning.message);
  assert.ok(warning.message.includes(reminted as string), warning.message);
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

test('过程卡标题时序：session/title 到达后就地重渲染，不新增 message_id', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));

  const before = recordedCards(h.transport);
  const processCard = before.find(
    (entry) => entry.card.header?.title.content === '飞书会话 · 过程',
  );
  assert.ok(processCard !== undefined);
  assert.ok(!JSON.stringify(processCard.card).includes('会话：'), 'no title yet');

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
    'title arrival must not create a new process card',
  );
  const patches = patchedCards(h.transport).filter(
    (patch) => patch.messageId === processCard.messageId,
  );
  assert.ok(patches.length >= 1, 'process card must be patched in place');
  assert.match(JSON.stringify(patches.at(-1)?.card), /真实标题/);

  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /真实标题/);
});

test('标题先到：过程卡首次渲染即用标题', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  const callsBefore = h.transport.calls.length;

  await h.bridge.handleSessionEvent(session, {
    type: 'session/title',
    data: { title: '早到标题' },
    time: 1,
  });
  assert.equal(h.transport.calls.length, callsBefore, 'no message before the process card exists');

  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 2));
  const processCard = recordedCards(h.transport).find(
    (entry) => entry.card.header?.title.content === '飞书会话 · 过程',
  );
  assert.ok(processCard !== undefined);
  assert.match(JSON.stringify(processCard.card), /会话：早到标题/);
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

test('agent 就绪后强制重渲过程卡：同一 message_id 且带上标题', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 1_000));

  const processCard = recordedCards(h.transport).find(
    (entry) => entry.card.header?.title.content === '飞书会话 · 过程',
  );
  assert.ok(processCard !== undefined);

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
    (patch) => patch.messageId === processCard.messageId,
  );
  assert.ok(patches.length >= 1, 'existing process card must be patched');
  assert.match(JSON.stringify(patches.at(-1)?.card), /服务端标题/);
  const firstLine = patches.at(-1)?.card.elements[0]?.text?.content ?? '';
  assert.ok(firstLine.startsWith('会话：服务端标题'), 'merged card starts with the title');
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

test('终态卡带标题：卡内含会话标题与完整正文，不另发文本', async (t) => {
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

  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const text = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.match(text, /会话：会话标题/);
  assert.match(text, /正文内容/);
  assert.equal(recordedTexts(h.transport).length, 0);
});

test('终态卡无标题：不写「未命名」，正文完整入卡', async (t) => {
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

  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const text = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.match(text, /正文内容/);
  assert.ok(!text.includes('未命名'));
  assert.ok(!text.includes('▸'));
  assert.equal(recordedTexts(h.transport).length, 0);
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
  assert.deepEqual(persisted.entries[legacyKey], { sessionId: 'feishu-legacy-shared', history: [] });
  assert.deepEqual(persisted.entries[newKey], { sessionId: newSession, history: [newSession] });
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

test('/new 立即物化会话：create 调用与 map 写入同一个 id，回复短 id', async (t) => {
  const h = makeHarness(t);
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  await h.bridge.handleInbound(inbound('/new'));

  const mapped = h.store.get(key);
  assert.ok(mapped !== undefined);
  const createCall = h.agents.createCalls.at(-1);
  assert.ok(createCall !== undefined);
  assert.equal(createCall.sessionId, mapped);
  assert.equal(createCall.meta.cwd, h.dir);
  assert.ok(h.agents.live.has(mapped as string), 'created agent must be live');
  assert.match(
    recordedTexts(h.transport).at(-1) ?? '',
    new RegExp(`已新建会话 ${mapped.slice(-8)}`),
  );
  // /new no longer relies on a later resume.
  await h.bridge.handleInbound(inbound('/rename 物化后'));
  assert.equal(h.logger.entries.filter((entry) => entry.message.startsWith('resume failed')).length, 0);
});

test('/new 物化失败：不写 map、回错误文案、保留旧会话', async (t) => {
  const h = makeHarness(t);
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  h.agents.failCreateWith = new Error('boom');
  await h.bridge.handleInbound(inbound('/new'));

  assert.equal(h.store.get(key), undefined, 'failed /new must not create a ghost map entry');
  assert.equal(h.store.keys().length, 0);
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /新建会话失败：boom/);
});

test('/sessions：map 里有但磁盘无日志的条目标「（未落地）」', async (t) => {
  const ghostKey = 'oc_chat\u0000omt_ghost';
  const h = makeHarness(t, {
    botOpenId: 'ou_bot',
    sessionExists: () => false,
    seedMap: { [ghostKey]: 'feishu-ghost-11111111' },
  });
  const command = (text: string) =>
    inbound(text, { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] });
  await h.bridge.handleInbound(command('hi'));
  await h.bridge.handleInbound(command('/sessions --all'));

  const text = recordedTexts(h.transport).at(-1) ?? '';
  const ghostLine = text.split('\n').find((line) => line.includes('11111111'));
  assert.ok(ghostLine !== undefined, text);
  assert.match(ghostLine, /（未落地）$/);
  const currentLine = text.split('\n').find((line) => line.startsWith('* ▸ '));
  assert.ok(currentLine !== undefined && !currentLine.includes('（未落地）'), text);
});

test('history：/new 把旧 id 留在 history，/sessions --all 枚举当前 + 历史', async (t) => {
  const h = makeHarness(t);
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  await h.bridge.handleInbound(inbound('hi'));
  const first = h.store.get(key) as string;
  await h.bridge.handleInbound(inbound('/new'));
  const second = h.store.get(key) as string;
  assert.notEqual(first, second);
  assert.equal(h.store.history(key)[0], second);
  assert.ok(h.store.history(key).includes(first));

  await h.bridge.handleInbound(inbound('/sessions --all'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.ok(text.includes(first.slice(-8)), text);
  assert.ok(text.includes(second.slice(-8)), text);
  assert.ok(text.split('\n').some((line) => line.startsWith('* ▸ ')));
});

test('重启模拟（v5 从磁盘 load）：/resume 命中 history 中的旧 id，并提到 history 首位', async (t) => {
  const currentId = 'feishu-1793464086695';
  const historyId = 'feishu-1793463503786';
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const h = makeHarness(t, {
    seedV5: {
      [key]: { sessionId: currentId, history: [currentId, historyId] },
    },
  });
  await h.bridge.handleInbound(inbound('hi'));
  assert.equal(h.store.get(key), currentId);

  await h.bridge.handleInbound(inbound(`/resume ${historyId.slice(-8)}`));
  assert.equal(h.store.get(key), historyId);
  assert.equal(h.store.history(key)[0], historyId);
  assert.ok(h.store.history(key).includes(currentId), 'old current stays reachable');
  assert.ok(h.agents.resumed.includes(historyId));
});

test('/sessions --all：历史条目也带幽灵标记', async (t) => {
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const liveId = 'feishu-1793464086695';
  const ghostId = 'feishu-1793463503786';
  const h = makeHarness(t, {
    seedV5: { [key]: { sessionId: liveId, history: [liveId, ghostId] } },
    sessionExists: (sessionId) => sessionId !== ghostId,
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/sessions --all'));

  const text = recordedTexts(h.transport).at(-1) ?? '';
  const ghostLine = text.split('\n').find((line) => line.includes(ghostId.slice(-8)));
  const liveLine = text.split('\n').find((line) => line.startsWith('* ▸ '));
  assert.ok(ghostLine !== undefined, text);
  assert.match(ghostLine, /（未落地）$/);
  assert.ok(liveLine !== undefined && !liveLine.includes('（未落地）'), text);
});

test('/resume 歧义：历史中两条同尾号给出候选且不切换', async (t) => {
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const currentId = 'feishu-current-99999999';
  const h = makeHarness(t, {
    seedV5: {
      [key]: {
        sessionId: currentId,
        history: [currentId, 'feishu-ambig-11111111', 'feishu-other-11111111'],
      },
    },
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/resume 11111111'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /命中 2 条会话/);
  assert.equal(h.store.get(key), currentId);
});

test('create 带 meta.caduceus 归属（p2p / topic / group-user），并写 ownership sidecar', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot' });
  await h.bridge.handleInbound(
    inbound('p2p', { chatType: 'p2p', chatId: 'oc_dm', senderOpenId: 'ou_x' }),
  );
  await h.bridge.handleInbound(
    inbound('topic', {
      chatType: 'group',
      chatId: 'oc_g',
      threadId: 'omt_t',
      senderOpenId: 'ou_x',
      mentions: ['ou_bot'],
    }),
  );
  await h.bridge.handleInbound(
    inbound('group', {
      chatType: 'group',
      chatId: 'oc_g2',
      senderOpenId: 'ou_y',
      mentions: ['ou_bot'],
    }),
  );

  const metas = h.agents.createCalls.map((call) => ({ ...call.meta.caduceus }));
  assert.deepEqual(metas[0], { chatId: 'oc_dm', scopeKey: 'oc_dm', kind: 'p2p' });
  assert.deepEqual(metas[1], {
    chatId: 'oc_g',
    scopeKey: 'oc_g\u0000omt_t',
    kind: 'topic',
  });
  assert.deepEqual(metas[2], {
    chatId: 'oc_g2',
    scopeKey: 'oc_g2\u0000ou_y',
    kind: 'group-user',
  });
  for (const call of h.agents.createCalls) {
    assert.ok(
      existsSync(join(h.dir, 'owners', `${call.sessionId}.json`)),
      `ownership sidecar missing for ${call.sessionId}`,
    );
  }
});

test('/adopt：磁盘孤儿命中 → 加入 history 并设为当前', async (t) => {
  const target = 'feishu-1793463503786';
  const h = makeHarness(t, { sessionIdsProvider: () => [target] });
  await h.bridge.handleInbound(inbound('hi'));
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const previous = h.store.get(key);
  assert.notEqual(previous, target);

  await h.bridge.handleInbound(inbound(`/adopt ${target.slice(-8)}`));
  assert.equal(h.store.get(key), target);
  assert.equal(h.store.history(key)[0], target);
  assert.ok(h.store.history(key).includes(previous as string));
  assert.ok(h.agents.resumed.includes(target));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已收养会话/);
});

test('/adopt：歧义列候选、零命中、已在其他 scope 下都给提示', async (t) => {
  // Ambiguity: two disk ids sharing the same tail.
  const ambiguous = makeHarness(t, {
    sessionIdsProvider: () => ['feishu-ambig-11111111', 'feishu-other-11111111'],
  });
  await ambiguous.bridge.handleInbound(inbound('hi'));
  const ambiguousKey = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const ambiguousBefore = ambiguous.store.get(ambiguousKey);
  await ambiguous.bridge.handleInbound(inbound('/adopt 11111111'));
  const ambiguousText = recordedTexts(ambiguous.transport).at(-1) ?? '';
  assert.match(ambiguousText, /命中 2 条会话/);
  assert.equal(ambiguous.store.get(ambiguousKey), ambiguousBefore);

  // Zero hit.
  const none = makeHarness(t);
  await none.bridge.handleInbound(inbound('hi'));
  await none.bridge.handleInbound(inbound('/adopt 99999999'));
  assert.match(recordedTexts(none.transport).at(-1) ?? '', /没找到可收养的会话/);

  // Already owned by another scope of this chat: refuse with its label.
  const foreignTarget = 'feishu-1793463503786';
  const foreignKey = 'oc_chat\u0000omt_foreign';
  const foreign = makeHarness(t, {
    botOpenId: 'ou_bot',
    seedMap: { [foreignKey]: foreignTarget },
    sessionIdsProvider: () => [],
  });
  await foreign.bridge.handleInbound(
    inbound('hi', { chatType: 'group', senderOpenId: 'ou_me', mentions: ['ou_bot'] }),
  );
  await foreign.bridge.handleInbound(
    inbound(`/adopt ${foreignTarget.slice(-8)}`, {
      chatType: 'group',
      senderOpenId: 'ou_me',
      mentions: ['ou_bot'],
    }),
  );
  const foreignText = recordedTexts(foreign.transport).at(-1) ?? '';
  assert.match(foreignText, /已在其他 scope 下/);
  assert.notEqual(foreign.store.get(scopeKey('group', 'oc_chat', null, 'ou_me')), foreignTarget);
});

test('一张过程卡；含状态/步数/最近事件', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(session, event('step/start', { turn: 1, step: 1 }, 110));
  await h.bridge.handleSessionEvent(session, event('tool/call', { turn: 1, step: 1 }, 120));
  h.clock.advance(400);
  await tick();

  const cards = recordedCards(h.transport);
  assert.deepEqual(cardTitles(cards), [PROCESS_CARD_TITLE], 'exactly one process card');
  const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const latest = finalPatchOfCard(h.transport, processCard.messageId) ?? processCard.card;
  const text = JSON.stringify(latest);
  assert.match(text, /\*\*运行中\*\*/);
  assert.match(text, /步数 1/);
  assert.match(text, /工具 1/);
  assert.match(text, /最近：tool\/call/);
  assert.match(text, /过程消息；收尾会把终稿更新到本卡/);
});

test('同一回合助手正文只在过程卡内出现（同 message_id）', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('请回答'));
  const session = liveAgent(h).session;
  const body = '这是第一句完整回答。这是第二句完整回答。';
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event(
      'assistant/message',
      { turn: 1, step: 1, message: { content: [{ type: 'text', text: body }] } },
      120,
    ),
  );
  await h.bridge.handleSessionEvent(session, event('tool/call', { turn: 1, step: 1 }, 130));
  h.clock.advance(400);
  await tick();
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );

  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const finalText = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  for (const sentence of ['这是第一句完整回答', '这是第二句完整回答']) {
    assert.equal(finalText.split(sentence).length - 1, 1, `"${sentence}" must appear once in the card`);
  }
  assert.equal(recordedTexts(h.transport).length, 0, 'no separate answer text');
  const bodyCardIds = new Set(
    [...recordedCards(h.transport), ...patchedCards(h.transport)]
      .filter((entry) => JSON.stringify(entry.card).includes('这是第一句完整回答'))
      .map((entry) => entry.messageId),
  );
  assert.equal(bodyCardIds.size, 1, 'the answer may live in exactly one card message');
});

test('卡片编辑失败才降级发一条文本，内容与卡一致并记日志', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('请回答'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '降级正文' }] } },
    time: 120,
  });
  // Flush the in-flight running patch first so the failure hits the FINAL edit.
  h.clock.advance(400);
  await tick();
  h.transport.failUpdateCardWith = new Error('patch rejected');

  await h.bridge.handleSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    time: 200,
  });

  const texts = recordedTexts(h.transport);
  assert.equal(texts.length, 1, 'exactly one fallback text, never double-send');
  const fallback = texts[0] ?? '';
  assert.match(fallback, /降级正文/, 'fallback carries the same answer body');
  assert.match(fallback, /完成/, 'fallback carries the same terminal state line');
  assert.ok(
    h.logger.entries.some((entry) => entry.message.startsWith('final fallback to text:')),
    h.logger.entries.map((entry) => entry.message).join(' | '),
  );
});

test('超长正文：终态卡 ≤30KB、保留尾部并写「…已省略 N 字符」', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('请长回答'));
  const session = liveAgent(h).session;
  const body = `开头标记${'汉'.repeat(20_000)}结尾标记`;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: body }] } },
    time: 120,
  });
  await h.bridge.handleSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    time: 200,
  });

  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const card = finalPatchOfCard(h.transport, processCard.messageId);
  assert.ok(card !== undefined);
  assert.ok(cardByteSize(card) <= CARD_BYTE_LIMIT, `card is ${cardByteSize(card)} bytes`);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /…已省略 \d+ 字符/);
  assert.ok(serialized.includes('结尾标记'), 'kept tail must include the end');
  assert.ok(!serialized.includes('开头标记'), 'dropped head must be gone');
  assert.ok(!serialized.includes('\uFFFD'), 'UTF-8 boundaries must stay safe');
  assert.equal(recordedTexts(h.transport).length, 0);
});


test('create：meta.agentPreset=standard 且 setup 里 mount 一次', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));

  const call = h.agents.createCalls.at(-1);
  assert.ok(call !== undefined);
  assert.equal(call.meta.agentPreset, 'standard');
  assert.deepEqual(h.agents.setupCalls, [{ sessionId: call.sessionId, phase: 'create' }]);
  assert.deepEqual(h.presets?.mountCalls, [{ id: 'standard' }]);
});

test('resume 已有 preset：composedPreset 命中 → 不再 mount', async (t) => {
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const h = makeHarness(t, { seedMap: { [key]: 'feishu-existing-1' } });
  if (h.presets !== undefined) h.presets.composedPresetValue = 'standard';

  await h.bridge.handleInbound(inbound('继续'));
  assert.deepEqual(h.agents.resumed, ['feishu-existing-1']);
  assert.equal(h.presets?.mountCalls.length, 0, 'already-composed resume must not mount again');
});

test('legacy resume（无 preset 头）：setup 里 mount 一次', async (t) => {
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const h = makeHarness(t, { seedMap: { [key]: 'feishu-legacy-no-preset' } });
  if (h.presets !== undefined) h.presets.composedPresetValue = undefined;

  await h.bridge.handleInbound(inbound('继续'));
  assert.deepEqual(h.agents.resumed, ['feishu-legacy-no-preset']);
  assert.deepEqual(h.presets?.mountCalls, [{ id: 'standard' }]);
});

test('mount 抛错：会话仍可用，warn 日志，状态行标「preset 未挂载」', async (t) => {
  const h = makeHarness(t);
  if (h.presets !== undefined) h.presets.mountError = new Error('mount boom');

  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  assert.equal(liveAgent(h).followups.length, 1, 'agent must remain usable after mount failure');
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('agent preset mount failed'),
    ),
    h.logger.entries.map((entry) => entry.message).join(' | '),
  );

  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  h.clock.advance(400);
  await tick();
  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const latest = finalPatchOfCard(h.transport, processCard.messageId) ?? processCard.card;
  assert.match(JSON.stringify(latest), /（preset 未挂载）/);
});

test('agentPreset 配置为 other：meta 与 mount 都用 other', async (t) => {
  const h = makeHarness(t, { agentPreset: 'other' });
  await h.bridge.handleInbound(inbound('hi'));

  assert.equal(h.agents.createCalls.at(-1)?.meta.agentPreset, 'other');
  assert.deepEqual(h.presets?.mountCalls, [{ id: 'other' }]);
});

test('agentPresets 服务缺失：warn 并继续，状态行标记未挂载', async (t) => {
  const h = makeHarness(t, { agentPresets: null });
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  assert.equal(liveAgent(h).followups.length, 1, 'agent remains usable');
  assert.ok(
    h.logger.entries.some((entry) => entry.message.includes('agentPresets service unavailable')),
    h.logger.entries.map((entry) => entry.message).join(' | '),
  );

  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  h.clock.advance(400);
  await tick();
  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const latest = finalPatchOfCard(h.transport, processCard.messageId) ?? processCard.card;
  assert.match(JSON.stringify(latest), /（preset 未挂载）/);
});

test('resume 旧会话 remint 时新会话也带 preset 并 mount', async (t) => {
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const h = makeHarness(t, { seedMap: { [key]: 'feishu-gone' } });
  h.agents.failResume.add('feishu-gone');

  await h.bridge.handleInbound(inbound('hi'));
  const reminted = h.store.get(key) as string;
  assert.notEqual(reminted, 'feishu-gone');
  assert.equal(h.agents.createCalls.at(-1)?.meta.agentPreset, 'standard');
  assert.deepEqual(h.presets?.mountCalls, [{ id: 'standard' }]);
});

test('resume 会话头已有 agentPreset：不传 setup，mount 零调用', async (t) => {
  const key = scopeKey('p2p', 'oc_chat', null, 'ou_user');
  const h = makeHarness(t, {
    seedMap: { [key]: 'feishu-header-has-preset' },
    sessionPresetLookup: (sessionId) =>
      sessionId === 'feishu-header-has-preset' ? 'standard' : undefined,
  });
  if (h.presets !== undefined) h.presets.composedPresetValue = undefined;

  await h.bridge.handleInbound(inbound('继续'));
  assert.deepEqual(h.agents.resumed, ['feishu-header-has-preset']);
  assert.equal(h.presets?.mountCalls.length, 0, 'header preset must skip mount');
});

test('agentPresets 惰性解析：apply 时缺失不缓存，服务晚注册后 create 能拿到并 mount', async (t) => {
  let service: FakeAgentPresets | undefined;
  let lookups = 0;
  const h = makeHarness(t, {
    agentPresetsProvider: () => {
      lookups += 1;
      return service;
    },
  });

  await h.bridge.handleInbound(inbound('第一轮'));
  assert.equal(lookups, 1);
  assert.ok(
    h.logger.entries.some((entry) =>
      entry.message.startsWith('agentPresets service unavailable; preset standard'),
    ),
    h.logger.entries.map((entry) => entry.message).join(' | '),
  );

  // Service registers after plugin apply: the miss must not have been cached.
  const late = new FakeAgentPresets();
  service = late;
  await h.bridge.handleInbound(inbound('/new'));

  assert.equal(lookups, 2, 'every create retries resolution until it succeeds');
  assert.deepEqual(late.mountCalls, [{ id: 'standard' }]);
  assert.ok(
    h.logger.entries.some((entry) => entry.message === 'agentPresets resolved; mounting standard'),
    h.logger.entries.map((entry) => entry.message).join(' | '),
  );
});

test('agentPresets 解析成功后复用缓存：第二次 create 不再重新解析', async (t) => {
  const presets = new FakeAgentPresets();
  let lookups = 0;
  const h = makeHarness(t, {
    agentPresetsProvider: () => {
      lookups += 1;
      return presets;
    },
  });

  await h.bridge.handleInbound(inbound('第一轮'));
  await h.bridge.handleInbound(inbound('/new'));

  assert.equal(lookups, 1, 'resolved service is reused');
  assert.deepEqual(presets.mountCalls, [{ id: 'standard' }, { id: 'standard' }], 'each agent mounts once');
  assert.equal(
    h.logger.entries.filter((entry) => entry.message === 'agentPresets resolved; mounting standard')
      .length,
    1,
    'resolution is logged once',
  );
});

test('/status 顶部显示自检行；/selfcheck 输出六项明细', async (t) => {
  const { SelfChecker } = await import('../src/selfcheck.js');
  const { syncSoul } = await import('../src/persona/blocks.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-selfcheck-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'agents-home'), { recursive: true });
  const env = { DSH_HOME: dir, DSH_AGENTS_HOME: join(dir, 'agents-home') };
  writeFileSync(join(dir, 'SOUL.md'), '人格\n', 'utf8');
  await syncSoul({ env });

  let presetsHolder: FakeAgentPresets | undefined;
  const checker = new SelfChecker({
    env,
    getAgentPresets: () => presetsHolder,
    getTools: () => ({}),
  });
  const h = makeHarness(t, {
    selfCheck: checker,
    agentPresetsProvider: () => presetsHolder,
  });
  presetsHolder = new FakeAgentPresets();
  presetsHolder.composedPresetValue = 'standard';
  await checker.runStageA();

  await h.bridge.handleInbound(inbound('hi'));
  const live = liveAgent(h).session;
  await h.bridge.handleSessionEvent(live, {
    type: 'request/header',
    data: { header: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, reason: 'initial' },
    time: 150,
  });
  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /^自检 ✓/);

  await h.bridge.handleInbound(inbound('/selfcheck'));
  const detail = recordedTexts(h.transport).at(-1) ?? '';
  for (const id of [
    'preset:service',
    'instructions:block',
    'persona:fresh',
    'tools:service',
    'preset:applied',
    'tools:count',
  ]) {
    assert.match(detail, new RegExp(`${id}: ok`), detail);
  }
});

test('/status 在 preset:applied 失败时显示自检 ✗', async (t) => {
  const { SelfChecker } = await import('../src/selfcheck.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-selfcheck-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checker = new SelfChecker({
    env: { DSH_HOME: dir, DSH_AGENTS_HOME: join(dir, 'agents') },
    getAgentPresets: () => ({ async mount() {}, composedPreset: () => undefined }),
    getTools: () => ({}),
  });
  const h = makeHarness(t, { selfCheck: checker });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /^自检 ✗ preset:applied/);
});

test('自检 tools:count 每会话只在首条 request/header 判一次', async (t) => {
  const checks: number[] = [];
  const fake = {
    async runStageB() {},
    async checkTools(count: number) {
      checks.push(count);
    },
    failureIds: () => [],
    failureItems: () => [],
    presetId: () => undefined,
    statusLine: () => '自检 ✓',
    detailText: () => '',
  } as unknown as import('../src/selfcheck.js').SelfChecker;
  const h = makeHarness(t, { selfCheck: fake });
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(session, event('step/start', { turn: 1, step: 1 }, 110));
  const header = (count: number): { type: string; data: unknown; time: number } => ({
    type: 'request/header',
    data: { header: { tools: Array.from({ length: count }, (_, i) => ({ name: `t${i}` })) }, reason: 'initial' },
    time: 120,
  });
  await h.bridge.handleSessionEvent(session, header(37));
  await h.bridge.handleSessionEvent(session, header(99));
  assert.deepEqual(checks, [37], 'only the first request/header is judged');
});

test('/doctor 输出分段文本；/doctor --json 输出可解析 JSON', async (t) => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { syncSoul } = await import('../src/persona/blocks.js');
  const base = mkdtempSync(join(tmpdir(), 'dsh-caduceus-doctor-bridge-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, 'agents-home'), { recursive: true });
  const env = { DSH_HOME: base, DSH_AGENTS_HOME: join(base, 'agents-home') };
  writeFileSync(join(base, 'SOUL.md'), '体检人格\n', 'utf8');
  await syncSoul({ env });

  let seenSession: { cwd?: string } | undefined;
  const h = makeHarness(t, {
    doctorInputs: (session) => {
      seenSession = session as unknown as { cwd?: string };
      return {
        versions: { plugin: '0.1.0', dsh: '0.2.1-rc.2', node: 'v22.23.2' },
        runtime: {
          preset: 'standard',
          presetMounted: true,
          toolsCount: 37,
          sessionTitleService: true,
          agentsService: true,
        },
        feishu: {
          appId: 'cli_aa1b2c3d4e5f6dbc1',
          botName: '伊冯',
          connectionReady: true,
          connectedSince: Date.now() - 1000,
          lastSendAt: Date.now() - 1000,
          lastSendKind: '卡片',
          sendFailures: 0,
        },
        persona: { env },
        session,
        storage: { mapVersion: 5, mapWritable: true, mapEntries: 1 },
      };
    },
  });

  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, {
    type: 'request/header',
    data: { header: { tools: [{ name: 'a' }, { name: 'b' }] }, reason: 'initial' },
    time: Date.now() - 2 * 60 * 1000,
  });
  await h.bridge.handleInbound(inbound('/doctor'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /^大肥鱼 · 体检/);
  for (const section of ['运行时', '飞书', '人格', '会话']) {
    assert.ok(text.includes(`【${section}】`), text);
  }
  assert.match(text, /【结论】\d+ 项正常 · 0 项异常 · \d+ 项跳过/);
  assert.match(text, /✓ 上一回合 · .*工具 2，/);
  assert.ok(seenSession !== undefined);

  await h.bridge.handleInbound(inbound('/doctor --json'));
  const json = recordedTexts(h.transport).at(-1) ?? '';
  const parsed = JSON.parse(json) as {
    sections: { title: string; items: { id: string; mark: string }[] }[];
    counts: { fail: number };
  };
  assert.deepEqual(parsed.sections.map((entry) => entry.title), ['运行时', '飞书', '人格', '会话']);
  assert.ok(parsed.sections.flatMap((entry) => entry.items.map((item) => item.id)).includes('preset'));
  assert.equal(parsed.counts.fail, 0);
  assert.ok(!json.includes('appSecret'));
  assert.ok(
    h.logger.entries.some((entry) => entry.level === 'info' && /^doctor: \d+ ok \/ 0 fail \/ \d+ skip$/.test(entry.message)),
    h.logger.entries.map((entry) => `${entry.level}:${entry.message}`).join(' | '),
  );
});

function fakeSelfCheck(initial: {
  id: string;
  detail: string;
  consequence?: string;
}[]): {
  fake: import('../src/selfcheck.js').SelfChecker;
  setFails(items: { id: string; detail: string; consequence?: string }[]): void;
} {
  let fails = initial;
  const fake = {
    failureIds: () => fails.map((entry) => entry.id).sort(),
    failureItems: () =>
      fails.map((entry) => ({
        id: entry.id,
        status: 'fail',
        detail: entry.detail,
        ...(entry.consequence === undefined ? {} : { consequence: entry.consequence }),
      })),
    lastFailureAt: () => Date.now(),
    async runStageB() {},
    async checkTools() {},
    presetId: () => 'standard',
    toolCount: () => undefined,
    presetMounted: () => true,
    statusLine: () => (fails.length > 0 ? `自检 ✗ ${fails.map((e) => e.id).join(', ')}` : '自检 ✓'),
    detailText: () => '',
  } as unknown as import('../src/selfcheck.js').SelfChecker;
  return { fake, setFails: (items) => { fails = items; } };
}

test('自检 fail 在会话里提示：同组一次、组合变化再发、恢复一次', async (t) => {
  const { fake, setFails } = fakeSelfCheck([
    { id: 'preset:applied', detail: 'agent 未挂载 preset', consequence: 'agent 无工具无人格' },
  ]);
  const h = makeHarness(t, { selfCheck: fake });

  await h.bridge.handleInbound(inbound('第一轮'));
  const alerts = () => recordedTexts(h.transport).filter((text) => text.startsWith('⚠ 自检异常'));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0] as string, /preset:applied — agent 无工具无人格/);
  assert.match(alerts()[0] as string, /（详情 \/doctor）/);

  await h.bridge.handleInbound(inbound('/status'));
  const statusText = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(statusText, /自检 ✗ preset:applied/);
  assert.match(statusText, /最近异常：preset:applied @/);

  await h.bridge.handleInbound(inbound('第二轮'));
  assert.equal(alerts().length, 1, 'same fail set is notified once');

  setFails([
    { id: 'preset:applied', detail: 'agent 未挂载 preset', consequence: 'agent 无工具无人格' },
    { id: 'tools:count', detail: 'request/header.tools 为空', consequence: 'request/header.tools 为空' },
  ]);
  await h.bridge.handleInbound(inbound('第三轮'));
  assert.equal(alerts().length, 2, 'changed fail set notifies again');
  assert.match(alerts()[1] as string, /preset:applied.*tools:count/);

  setFails([]);
  await h.bridge.handleInbound(inbound('第四轮'));
  const recovery = recordedTexts(h.transport).filter((text) => text === '✓ 自检已恢复');
  assert.equal(recovery.length, 1);
  await h.bridge.handleInbound(inbound('第五轮'));
  assert.equal(
    recordedTexts(h.transport).filter((text) => text === '✓ 自检已恢复').length,
    1,
    'recovery is sent once',
  );
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'selfcheck recovered',
    ),
  );
});

test('ready 阶段自检 fail 不立即发；首个会话消息补发一次', async (t) => {
  const { fake } = fakeSelfCheck([
    { id: 'instructions:block', detail: 'AGENTS.md 人格块缺失', consequence: '人格缺失' },
  ]);
  const h = makeHarness(t, { selfCheck: fake });
  assert.equal(
    recordedTexts(h.transport).filter((text) => text.startsWith('⚠ 自检异常')).length,
    0,
  );

  await h.bridge.handleInbound(inbound('第一条消息'));
  assert.equal(
    recordedTexts(h.transport).filter((text) => text.startsWith('⚠ 自检异常')).length,
    1,
  );
});

test('自检提示发送失败：不抛错、不重试、日志 warn', async (t) => {
  const { fake } = fakeSelfCheck([
    { id: 'preset:applied', detail: '未挂载', consequence: 'agent 无工具无人格' },
  ]);
  const h = makeHarness(t, { selfCheck: fake });
  h.transport.reply = async () => {
    throw new Error('feishu reply boom');
  };

  await assert.doesNotReject(h.bridge.handleInbound(inbound('hi')));
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('reply failed'),
    ),
    h.logger.entries.map((entry) => `${entry.level}:${entry.message}`).join(' | '),
  );
  // Second message must not retry the same alert (signature was consumed).
  await h.bridge.handleInbound(inbound('second'));
  const replyAttempts = h.logger.entries.filter((entry) =>
    entry.message.startsWith('reply failed'),
  );
  assert.equal(replyAttempts.length >= 1, true);
});

test('交互答者在插件根 ctx 注册一次，不在每个 agent setup 上注册', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: async () => ({ messageId: 'm' }),
    updateCard: async () => undefined,
  });
  const listeners = new Map<string, (...args: any[]) => any>();
  const rootCtx = {
    on(name: string, listener: (...args: any[]) => any) {
      listeners.set(name, listener);
      return listener;
    },
  };
  const h = makeHarness(t, { interactive: runtime, rootCtx });
  assert.ok(listeners.has('approval/request'));
  assert.ok(listeners.has('user-questions/request'));

  await h.bridge.handleInbound(inbound('hi'));
  // setup runs for the agent, but the bridge must not register per-agent answerers.
  assert.ok(h.agents.setupScopes.length > 0);
  for (const scope of h.agents.setupScopes) {
    assert.ok(!scope.listeners.has('approval/request'));
    assert.ok(!scope.listeners.has('user-questions/request'));
  }

  await h.bridge.handleInbound(inbound('/new'));
  assert.equal(listeners.size, 2, 'root registration must happen once');
});

test('审批策略：创建会话默认调用 setPolicy(agent, ask) 并打日志', async (t) => {
  const calls: { agent: AgentLike; policy: ApprovalPolicy }[] = [];
  const h = makeHarness(t, {
    approvalProvider: () => ({
      setPolicy: (agent, policy) => {
        calls.push({ agent, policy });
      },
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.agent, liveAgent(h));
  assert.equal(calls[0]?.policy, 'ask');
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'agent approval policy=ask',
    ),
  );
});

test('审批策略：配置 never 时传 never', async (t) => {
  const calls: ApprovalPolicy[] = [];
  const h = makeHarness(t, {
    approvalPolicy: 'never',
    approvalProvider: () => ({
      setPolicy: (_agent, policy) => {
        calls.push(policy);
      },
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  assert.deepEqual(calls, ['never']);
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'agent approval policy=never',
    ),
  );
});

test('审批策略：服务缺失不抛、只 warn 一次', async (t) => {
  const h = makeHarness(t, { approvalProvider: () => undefined });
  await h.bridge.handleInbound(inbound('第一条'));
  await h.bridge.handleInbound(inbound('/new'));
  const warnings = h.logger.entries.filter(
    (entry) => entry.level === 'warn' && entry.message.includes('approval service unavailable'),
  );
  assert.equal(warnings.length, 1);
  assert.ok(liveAgent(h) !== undefined);
});

test('审批策略：resume 路径同样调用 setPolicy', async (t) => {
  const calls: { agent: AgentLike; policy: ApprovalPolicy }[] = [];
  const h = makeHarness(t, {
    approvalProvider: () => ({
      setPolicy: (agent, policy) => {
        calls.push({ agent, policy });
      },
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  const firstId = liveAgent(h).session.id;
  await h.bridge.handleInbound(inbound('/new'));
  h.agents.live.delete(firstId);
  await h.bridge.handleInbound(inbound(`/resume ${firstId.slice(-8)}`));
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.policy), ['ask', 'ask', 'ask']);
  assert.equal(calls.at(-1)?.agent.session.id, firstId);
});
