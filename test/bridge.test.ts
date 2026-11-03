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
  type TransportCall,
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
  /** Emoji reactions switch/defaults (bridge defaults true/OnIt/DONE/CROSS_MARK). */
  readonly reactions?: boolean;
  readonly reactionOnStart?: string;
  readonly reactionOnDone?: string;
  readonly reactionOnFail?: string;
  /** Default true; false restores the old fail-open group gate. */
  readonly gateRequireBotIdentity?: boolean;
  /** Attachment service double. */
  readonly attachmentProvider?: () => import('../src/bridge/types.js').AttachmentStoreLike | undefined;
  readonly images?: boolean;
  readonly files?: boolean;
  readonly maxAttachmentBytes?: number;
  readonly sendMedia?: boolean;
  readonly maxSendFileBytes?: number;
  readonly maxSendImageBytes?: number;
  readonly mediaRoots?: readonly string[];
  readonly admins?: readonly string[];
  readonly exportProvider?: import('../src/export.js').SessionExportProvider;
  readonly permissionPresetsProvider?: () => import('../src/bridge/types.js').PermissionPresetsLike | undefined;
  readonly metrics?: import('../src/metrics.js').MetricsMode;
  readonly usageProvider?: (
    sessionId: string,
  ) => Promise<readonly unknown[] | undefined> | readonly unknown[] | undefined;
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
    ...(options.reactions === undefined ? {} : { reactions: options.reactions }),
    ...(options.reactionOnStart === undefined
      ? {}
      : { reactionOnStart: options.reactionOnStart }),
    ...(options.reactionOnDone === undefined ? {} : { reactionOnDone: options.reactionOnDone }),
    ...(options.reactionOnFail === undefined ? {} : { reactionOnFail: options.reactionOnFail }),
    ...(options.gateRequireBotIdentity === undefined
      ? {}
      : { gateRequireBotIdentity: options.gateRequireBotIdentity }),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.maxAttachmentBytes === undefined
      ? {}
      : { maxAttachmentBytes: options.maxAttachmentBytes }),
    ...(options.sendMedia === undefined ? {} : { sendMedia: options.sendMedia }),
    ...(options.maxSendFileBytes === undefined
      ? {}
      : { maxSendFileBytes: options.maxSendFileBytes }),
    ...(options.maxSendImageBytes === undefined
      ? {}
      : { maxSendImageBytes: options.maxSendImageBytes }),
    ...(options.mediaRoots === undefined ? {} : { mediaRoots: options.mediaRoots }),
    ...(options.admins === undefined ? {} : { admins: options.admins }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
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
    ...(options.attachmentProvider === undefined
      ? {}
      : { attachmentProvider: options.attachmentProvider }),
    ...(options.approvalProvider === undefined
      ? {}
      : { approvalProvider: options.approvalProvider }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    ...(options.doctorInputs === undefined ? {} : { doctorInputs: options.doctorInputs }),
    ...(options.exportProvider === undefined
      ? {}
      : { exportProvider: options.exportProvider }),
    ...(options.permissionPresetsProvider === undefined
      ? {}
      : { permissionPresetsProvider: options.permissionPresetsProvider }),
    ...(options.usageProvider === undefined
      ? {}
      : { usageProvider: options.usageProvider }),
  });
  return { dir, store, presets: agentPresets, transport, agents, clock, logger, titles, bridge };
}

function buttonsOf(card: FeishuCard): {
  readonly label: string;
  readonly value: Record<string, unknown>;
}[] {
  const action = card.elements.find((element) => element.tag === 'action') as
    | { actions?: { text?: { content?: string }; value?: Record<string, unknown> }[] }
    | undefined;
  return (action?.actions ?? []).map((button) => ({
    label: button.text?.content ?? '',
    value: button.value ?? {},
  }));
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
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已停止当前回合。后台任务仍在运行，完成后结果会回来。/);
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


function tempDshHome(t: TestContext): string {
  const saved = process.env['DSH_HOME'];
  const dir = mkdtempSync(join(tmpdir(), 'dsh-export-cache-'));
  process.env['DSH_HOME'] = dir;
  t.after(() => {
    if (saved === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('未知命令：/export 自有处理，其余转交命令注册表', async (t) => {
  const forwarded: string[] = [];
  const h = makeHarness(t, {
    commandRunner: async (_agent, line) => {
      forwarded.push(line);
      if (line === '/compact') return { kind: 'success', text: '压缩完成' };
      return undefined;
    },
  });

  await h.bridge.handleInbound(inbound('/export'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /没有可导出的会话|没有可导出的日志/);
  assert.deepEqual(forwarded, [], 'owned export must not reach the registry');

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

test('@ 门禁：bot open id 未知 fail-closed，ERROR 仅一次；恢复身份后放行', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(
    inbound('@某人', { chatType: 'group', mentions: ['ou_anyone'] }),
  );
  assert.equal(h.agents.live.size, 0, 'unknown bot identity must reject group @ messages');
  assert.equal(
    h.logger.entries.filter(
      (entry) =>
        entry.level === 'error' && entry.message.includes('bot identity unknown'),
    ).length,
    1,
  );

  await h.bridge.handleInbound(
    inbound('@某人 再来', { chatType: 'group', mentions: ['ou_anyone'] }),
  );
  assert.equal(h.agents.live.size, 0);
  assert.equal(
    h.logger.entries.filter(
      (entry) =>
        entry.level === 'error' && entry.message.includes('bot identity unknown'),
    ).length,
    1,
    'identity-unknown ERROR is logged once per process',
  );

  // bot/v3/info succeeds later: the next group message refreshes and accepts.
  h.transport.setBotOpenId('ou_bot');
  await h.bridge.handleInbound(
    inbound('@机器人', { chatType: 'group', mentions: ['ou_bot'] }),
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
  h.transport.sendText = async () => {
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

test('审批策略：默认不配置 → setPolicy 零调用', async (t) => {
  const calls: { agent: AgentLike; policy: ApprovalPolicy }[] = [];
  const h = makeHarness(t, {
    approvalProvider: () => ({
      setPolicy: (agent, policy) => {
        calls.push({ agent, policy });
      },
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  assert.equal(calls.length, 0);
  assert.ok(
    !h.logger.entries.some((entry) => entry.message.includes('agent approval policy')),
  );
});

test('审批策略：显式 ask → setPolicy 调用一次', async (t) => {
  const calls: { agent: AgentLike; policy: ApprovalPolicy }[] = [];
  const h = makeHarness(t, {
    approvalPolicy: 'ask',
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

test('审批策略：显式覆盖但服务缺失 → 不抛、只 warn 一次', async (t) => {
  const h = makeHarness(t, { approvalPolicy: 'ask', approvalProvider: () => undefined });
  await h.bridge.handleInbound(inbound('第一条'));
  await h.bridge.handleInbound(inbound('/new'));
  const warnings = h.logger.entries.filter(
    (entry) => entry.level === 'warn' && entry.message.includes('approval service unavailable'),
  );
  assert.equal(warnings.length, 1);
  assert.ok(liveAgent(h) !== undefined);
});

test('审批策略：resume 路径同样调用 setPolicy（显式覆盖时）', async (t) => {
  const calls: { agent: AgentLike; policy: ApprovalPolicy }[] = [];
  const h = makeHarness(t, {
    approvalPolicy: 'ask',
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

test('交互卡：话题会话走 reply + threadId，不走 createMessage', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: (sessionId, card) => h.bridge.sendInteractiveCard(sessionId, card),
    updateCard: async () => undefined,
  });
  const listeners = new Map<string, (...args: any[]) => any>();
  const rootCtx = {
    on(name: string, listener: (...args: any[]) => any) {
      listeners.set(name, listener);
      return listener;
    },
  };
  const h = makeHarness(t, {
    interactive: runtime,
    rootCtx,
    botOpenId: 'ou_bot',
    prebindTopic: true,
  });
  const topicMessage = inbound('hi', {
    chatType: 'group',
    chatId: 'oc_g',
    threadId: 'omt_t',
    senderOpenId: 'ou_me',
    mentions: ['ou_bot'],
  });
  await h.bridge.handleInbound(topicMessage);
  const sessionId = liveAgent(h).session.id;
  const promise = listeners.get('approval/request')!(
    { agent: { session: { id: sessionId } }, toolName: 'bash', reason: '需要执行命令' },
    async () => 'unavailable',
  );
  await tick();
  const cardReplies = h.transport.calls.filter(
    (call) =>
      call.op === 'reply' &&
      call.threadId === 'omt_t' &&
      JSON.stringify(call.payload).includes('审批请求'),
  );
  assert.equal(cardReplies.length, 1);
  assert.ok(
    !h.transport.calls.some(
      (call) => call.op === 'sendCard' && JSON.stringify(call.card).includes('审批请求'),
    ),
    'interactive card must not use createMessage/chat send',
  );
  const buttons = buttonsOf((cardReplies[0] as { payload: { card: FeishuCard } }).payload.card);
  await h.bridge.handleInbound(
    inbound('/status', {
      chatType: 'group',
      chatId: 'oc_g',
      threadId: 'omt_t',
      senderOpenId: 'ou_me',
      mentions: ['ou_bot'],
    }),
  );
  await runtime.handleCardAction({
    operatorOpenId: 'ou_me',
    messageId: (cardReplies[0] as { messageId: string }).messageId,
    chatId: 'oc_g',
    value: buttons[0]!.value,
  });
  assert.equal(await promise, 'allowed-once');
});

test('交互卡：私聊会话走 sendCard，不 reply', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: (sessionId, card) => h.bridge.sendInteractiveCard(sessionId, card),
    updateCard: async () => undefined,
  });
  const listeners = new Map<string, (...args: any[]) => any>();
  const h = makeHarness(t, {
    interactive: runtime,
    rootCtx: {
      on(name: string, listener: (...args: any[]) => any) {
        listeners.set(name, listener);
        return listener;
      },
    },
  });
  const message = inbound('hi');
  await h.bridge.handleInbound(message);
  const sessionId = liveAgent(h).session.id;
  const promise = listeners.get('approval/request')!(
    { agent: { session: { id: sessionId } }, toolName: 'bash' },
    async () => 'unavailable',
  );
  await tick();
  const sentCard = h.transport.calls.find(
    (call): call is Extract<TransportCall, { op: 'sendCard' }> =>
      call.op === 'sendCard' && JSON.stringify(call.card).includes('审批请求'),
  );
  assert.ok(sentCard !== undefined, 'private chat must send a plain card');
  assert.ok(
    !h.transport.calls.some(
      (call) => call.op === 'reply' && JSON.stringify(call.payload).includes('审批请求'),
    ),
    'private chat must not use a quoted reply for interactive cards',
  );
  const buttons = buttonsOf(sentCard.card);
  await runtime.handleCardAction({
    operatorOpenId: message.senderOpenId,
    messageId: sentCard.messageId,
    chatId: message.chatId,
    value: buttons[0]!.value,
  });
  assert.equal(await promise, 'allowed-once');
});

test('交互卡：无 scope state 时回退 chat send 并 warn', async (t) => {
  const h = makeHarness(t);
  const card: FeishuCard = {
    config: { update_multi: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'fallback' } }],
  };
  await h.bridge.sendInteractiveCard('missing-session', card);
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'warn' &&
        entry.message ===
          'interactive: no scope state for missing-session; falling back to chat send',
    ),
  );
  assert.equal(
    h.transport.calls.filter(
      (call) => call.op === 'sendCard' && JSON.stringify(call.card).includes('fallback'),
    ).length,
    1,
  );
});

test('表情反馈：接受消息加 OnIt；turn/end completed 删 OnIt 并加 DONE', async (t) => {
  const h = makeHarness(t);
  const message = inbound('hi');
  await h.bridge.handleInbound(message);
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/end', { reason: { kind: 'completed' } }));

  assert.deepEqual(
    h.transport.reactionCalls.map((call) => [call.action, call.messageId, call.emojiType ?? call.reactionId]),
    [
      ['add', message.messageId, 'OnIt'],
      ['remove', message.messageId, 'reaction-1'],
      ['add', message.messageId, 'DONE'],
    ],
  );
});

test('表情反馈：turn/end error 删 OnIt 并加 CROSS_MARK', async (t) => {
  const h = makeHarness(t);
  const message = inbound('hi');
  await h.bridge.handleInbound(message);
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/end', { reason: { kind: 'error' } }));
  assert.deepEqual(
    h.transport.reactionCalls.map((call) => [call.action, call.emojiType ?? call.reactionId]),
    [
      ['add', 'OnIt'],
      ['remove', 'reaction-1'],
      ['add', 'CROSS_MARK'],
    ],
  );
});

test('表情反馈：API 抛错只记 debug，不影响 turn/end', async (t) => {
  const h = makeHarness(t);
  h.transport.failAddReactionWith = new Error('emoji invalid');
  const message = inbound('hi');
  await h.bridge.handleInbound(message);
  const session = liveAgent(h).session;
  await assert.doesNotReject(
    h.bridge.handleSessionEvent(session, event('turn/end', { reason: { kind: 'completed' } })),
  );
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'debug' && entry.message === 'reaction skipped: unknown emoji invalid',
    ),
    h.logger.entries.map((entry) => `${entry.level}:${entry.message}`).join(' | '),
  );
  assert.ok(
    h.transport.reactionCalls.some(
      (call) => call.action === 'add' && call.messageId === message.messageId,
    ),
  );
});

test('表情反馈：reactions=false 零调用', async (t) => {
  const h = makeHarness(t, { reactions: false });
  const message = inbound('hi');
  await h.bridge.handleInbound(message);
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/end', { reason: { kind: 'completed' } }));
  assert.deepEqual(h.transport.reactionCalls, []);
});

test('表情反馈：连续两轮各自 reaction_id，不串号', async (t) => {
  const h = makeHarness(t);
  const first = inbound('第一轮');
  await h.bridge.handleInbound(first);
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/end', { reason: { kind: 'completed' } }));

  const second = inbound('第二轮');
  await h.bridge.handleInbound(second);
  await h.bridge.handleSessionEvent(session, event('turn/end', { reason: { kind: 'completed' } }));

  assert.deepEqual(
    h.transport.reactionCalls.map((call) => [call.action, call.messageId, call.emojiType ?? call.reactionId]),
    [
      ['add', first.messageId, 'OnIt'],
      ['remove', first.messageId, 'reaction-1'],
      ['add', first.messageId, 'DONE'],
      ['add', second.messageId, 'OnIt'],
      ['remove', second.messageId, 'reaction-3'],
      ['add', second.messageId, 'DONE'],
    ],
  );
});

test('@ 门禁：gateRequireBotIdentity=false 时保留旧 fail-open 行为', async (t) => {
  const h = makeHarness(t, { gateRequireBotIdentity: false });
  await h.bridge.handleInbound(
    inbound('@某人', { chatType: 'group', mentions: ['ou_anyone'] }),
  );
  assert.equal(liveAgent(h).followups.length, 1);
});

interface FakeAttachmentStore {
  readonly promptInputs: unknown[][];
  readonly fileInputs: unknown[];
  readonly store: import('../src/bridge/types.js').AttachmentStoreLike;
}

function fakeAttachmentStore(): FakeAttachmentStore {
  const promptInputs: unknown[][] = [];
  const fileInputs: unknown[] = [];
  return {
    promptInputs,
    fileInputs,
    store: {
      admitPromptContent: async (parts) => {
        promptInputs.push([...parts]);
        return parts.map((part) => {
          if (typeof part === 'object' && part !== null && (part as { type?: string }).type === 'image') {
            return {
              type: 'image',
              attachment: {
                attachmentId: 'att-1',
                mediaType: 'image/png',
                bytes: 3,
                width: 1,
                height: 1,
              },
            };
          }
          return part;
        });
      },
      admitEncodedFile: async (input) => {
        fileInputs.push(input);
        return { attachmentId: 'file-1', name: input.name ?? 'file', bytes: 1 };
      },
    },
  };
}

test('附件：图片下载一次、admitPromptContent 收到 image part、用户消息含 image 块', async (t) => {
  const attachments = fakeAttachmentStore();
  const h = makeHarness(t, { attachmentProvider: () => attachments.store });
  h.transport.downloadResult = {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'image/png',
  };
  const message = {
    ...inbound(''),
    text: '',
    attachments: [{ kind: 'image' as const, fileKey: 'img_1' }],
  };
  await h.bridge.handleInbound(message);
  assert.equal(h.transport.downloadCalls.length, 1);
  assert.deepEqual(h.transport.downloadCalls[0], {
    messageId: message.messageId,
    fileKey: 'img_1',
    type: 'image',
  });
  assert.equal(attachments.promptInputs.length, 1);
  const parts = attachments.promptInputs[0]!;
  assert.equal((parts[1] as { type: string }).type, 'image');
  assert.equal((parts[1] as { mediaType: string }).mediaType, 'image/png');
  const userMessage = h.agents.live.get(liveAgent(h).id)?.followups[0];
  assert.ok(userMessage !== undefined);
  assert.ok(
    userMessage.content.some((block) => block.type === 'image'),
    'user message must carry the admitted image block',
  );
});

test('附件：纯图无文字不丢，text 为空串', async (t) => {
  const attachments = fakeAttachmentStore();
  const h = makeHarness(t, { attachmentProvider: () => attachments.store });
  const message = {
    ...inbound(''),
    text: '',
    attachments: [{ kind: 'image' as const, fileKey: 'img_1' }],
  };
  await h.bridge.handleInbound(message);
  const userMessage = liveAgent(h).followups[0]!;
  assert.ok(userMessage !== undefined);
  const textBlock = userMessage.content.find((block) => block.type === 'text') as
    | { text: string }
    | undefined;
  assert.equal(textBlock?.text, '');
});

test('附件：下载超限 → 文件太大 + CROSS_MARK，不进 agent', async (t) => {
  const attachments = fakeAttachmentStore();
  const h = makeHarness(t, { attachmentProvider: () => attachments.store });
  h.transport.failDownloadWith = new Error('attachment too large (999 > 20)');
  const message = {
    ...inbound('看图'),
    text: '看图',
    attachments: [{ kind: 'image' as const, fileKey: 'img_big' }],
  };
  await h.bridge.handleInbound(message);
  assert.equal(h.agents.live.size, 0);
  assert.ok(recordedTexts(h.transport).some((text) => text.includes('文件太大')));
  assert.ok(
    h.transport.reactionCalls.some(
      (call) => call.action === 'add' && call.emojiType === 'CROSS_MARK',
    ),
  );
});

test('附件：images=false 退回纯文本并提示，不下载', async (t) => {
  const h = makeHarness(t, { images: false });
  const message = {
    ...inbound('看这张'),
    text: '看这张',
    attachments: [{ kind: 'image' as const, fileKey: 'img_1' }],
  };
  await h.bridge.handleInbound(message);
  assert.equal(h.transport.downloadCalls.length, 0);
  assert.ok(recordedTexts(h.transport).some((text) => text.includes('未启用图片/文件')));
  const userMessage = liveAgent(h).followups[0]!;
  assert.deepEqual(
    userMessage.content,
    [{ type: 'text', text: '看这张' }],
  );
});

test('附件：音频等不支持类型 → 暂不支持回复 + CROSS_MARK', async (t) => {
  const h = makeHarness(t);
  const message = { ...inbound(''), text: '', unsupportedType: 'audio' };
  await h.bridge.handleInbound(message);
  assert.equal(h.agents.live.size, 0);
  assert.ok(recordedTexts(h.transport).some((text) => text.includes('这类消息暂不支持')));
  assert.ok(
    h.transport.reactionCalls.some(
      (call) => call.action === 'add' && call.emojiType === 'CROSS_MARK',
    ),
  );
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'unsupported message type: audio',
    ),
  );
});

test('终态卡：turn/end completed 时状态行以事件为准显示「完成」', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('你好'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event('assistant/message', { message: { content: [{ type: 'text', text: '答复正文' }] } }, 150),
  );
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );
  const cards = recordedCards(h.transport);
  const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const cardText = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.match(cardText, /完成/);
  assert.ok(!cardText.includes('运行中'), 'stale running label must not survive');
  assert.match(cardText, /答复正文/);
});

test('终态卡：error → 失败，interrupted → 已中断（事件优先于快照）', async (t) => {
  for (const [kind, label] of [
    ['error', '失败'],
    ['interrupted', '已中断'],
  ] as const) {
    const h = makeHarness(t);
    await h.bridge.handleInbound(inbound('会结束的一轮'));
    const session = liveAgent(h).session;
    await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
    await h.bridge.handleSessionEvent(
      session,
      event('turn/end', { turn: 1, reason: { kind } }, 200),
    );
    const cards = recordedCards(h.transport);
    const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
    assert.ok(processCard !== undefined);
    const cardText = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
    assert.match(cardText, new RegExp(label));
    assert.ok(!cardText.includes('运行中'), `stale running label for ${kind}`);
  }
});

test('终态卡：正文为空仍显示终态 + 「本轮已结束」占位', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('空答复'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );
  const cards = recordedCards(h.transport);
  const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const cardText = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.match(cardText, /完成/);
  assert.match(cardText, /本轮已结束（完成）/);
});

test('MEDIA：两个文件 → 正文剥除、卡片尾注、图片/文件各走不同上传并回复', async (t) => {
  const h = makeHarness(t);
  const image = join(h.dir, 'chart.png');
  const file = join(h.dir, 'report.pdf');
  writeFileSync(image, Buffer.from([1, 2, 3]));
  writeFileSync(file, Buffer.from([4, 5, 6]));
  await h.bridge.handleInbound(inbound('给我结果'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event(
      'assistant/message',
      { message: { content: [{ type: 'text', text: `结果如下\nMEDIA:${image}\nMEDIA:${file}` }] } },
      150,
    ),
  );
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );

  assert.equal(h.transport.uploadedImages.length, 1);
  assert.equal(h.transport.uploadedFiles.length, 1);
  assert.equal(h.transport.uploadedFiles[0]?.fileName, 'report.pdf');
  const mediaReplies = h.transport.calls.filter(
    (call): call is Extract<TransportCall, { op: 'reply' }> =>
      call.op === 'reply' && call.payload.kind !== 'text' && call.payload.kind !== 'card',
  );
  assert.deepEqual(
    mediaReplies.map((call) => call.payload.kind),
    ['image', 'file'],
  );

  const cards = recordedCards(h.transport);
  const processCard = cardOfTitle(cards, PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const finalCard = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.ok(!finalCard.includes('MEDIA:'), 'markers must be stripped from the card');
  assert.match(finalCard, /📎 chart\.png × 1/);
  assert.match(finalCard, /📎 report\.pdf × 1/);
  assert.match(finalCard, /结果如下/);
});

test('MEDIA：相对路径/不存在/越界 → 跳过并写卡片原因，不调用上传', async (t) => {
  const h = makeHarness(t);
  const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-media-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  const outside = join(outsideDir, 'secret.txt');
  writeFileSync(outside, 'x');
  await h.bridge.handleInbound(inbound('发文件'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event(
      'assistant/message',
      {
        message: {
          content: [{
            type: 'text',
            text: `正文\nMEDIA:relative.txt\nMEDIA:${join(h.dir, 'missing.txt')}\nMEDIA:${outside}`,
          }],
        },
      },
      150,
    ),
  );
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );
  assert.equal(h.transport.uploadedFiles.length, 0);
  assert.equal(h.transport.uploadedImages.length, 0);
  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  const text = JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId));
  assert.match(text, /📎 relative\.txt：未发送（仅支持绝对路径）/);
  assert.match(text, /📎 missing\.txt：未发送（文件不存在）/);
  assert.match(text, /📎 secret\.txt：未发送（路径不在允许目录内）/);
});

test('MEDIA：超过发送上限 → 不调用上传，卡片注明', async (t) => {
  const h = makeHarness(t, { maxSendFileBytes: 10 });
  const file = join(h.dir, 'big.zip');
  writeFileSync(file, Buffer.alloc(20));
  await h.bridge.handleInbound(inbound('大文件'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event('assistant/message', {
      message: { content: [{ type: 'text', text: `MEDIA:${file}` }] },
    }, 150),
  );
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );
  assert.equal(h.transport.uploadedFiles.length, 0);
  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  assert.match(
    JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId)),
    /📎 big\.zip：未发送（超过大小限制）/,
  );
});

test('MEDIA：单个上传失败 → 其余文件照发，warn 日志', async (t) => {
  const h = makeHarness(t);
  const first = join(h.dir, 'a.pdf');
  const second = join(h.dir, 'b.pdf');
  writeFileSync(first, 'a');
  writeFileSync(second, 'b');
  h.transport.failUploadFileWith = new Error('upload boom');
  await h.bridge.handleInbound(inbound('文件'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event('assistant/message', {
      message: { content: [{ type: 'text', text: `MEDIA:${first}\nMEDIA:${second}` }] },
    }, 150),
  );
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );
  assert.equal(h.transport.uploadedFiles.length, 1);
  assert.equal(
    h.logger.entries.filter(
      (entry) => entry.level === 'warn' && entry.message.includes('media send failed'),
    ).length,
    1,
  );
});

test('MEDIA：sendMedia=false → 零上传，标记原样保留在正文', async (t) => {
  const h = makeHarness(t, { sendMedia: false });
  const file = join(h.dir, 'report.pdf');
  writeFileSync(file, 'x');
  await h.bridge.handleInbound(inbound('文件'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event('assistant/message', {
      message: { content: [{ type: 'text', text: `报告\nMEDIA:${file}` }] },
    }, 150),
  );
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 200),
  );
  assert.equal(h.transport.uploadedFiles.length, 0);
  assert.equal(h.transport.uploadedImages.length, 0);
  const processCard = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(processCard !== undefined);
  assert.match(
    JSON.stringify(finalPatchOfCard(h.transport, processCard.messageId)),
    /MEDIA:/,
  );
});

test('访问控制：admins=[] 时任意发送者放行', async (t) => {
  const h = makeHarness(t, { admins: [] });
  await h.bridge.handleInbound(inbound('hi', { senderOpenId: 'ou_anyone' }));
  assert.equal(liveAgent(h).followups.length, 1);
});

test('访问控制：非管理员被拒，不建会话/不调 agent/无卡片；/help 与 /whoami 放行', async (t) => {
  const h = makeHarness(t, { admins: ['ou_admin'] });
  const guest = { senderOpenId: 'ou_guest' };

  await h.bridge.handleInbound(inbound('/stop', guest));
  assert.ok(recordedTexts(h.transport).some((text) => text.includes('访客无执行权限')));
  assert.equal(h.agents.live.size, 0);
  assert.equal(h.agents.created.length, 0);
  assert.equal(recordedCards(h.transport).length, 0);
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' &&
        entry.message === 'gate drop: not-admin sender=ou_guest',
    ),
  );

  await h.bridge.handleInbound(inbound('普通消息', guest));
  assert.equal(h.agents.live.size, 0);
  assert.equal(recordedCards(h.transport).length, 0);

  await h.bridge.handleInbound(inbound('/help', guest));
  assert.ok(recordedTexts(h.transport).some((text) => text.includes('/whoami')));
  await h.bridge.handleInbound(inbound('/whoami', guest));
  const whoami = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(whoami, /你的 open_id：ou_guest/);
  assert.match(whoami, /当前会话：oc_chat/);
  assert.match(whoami, /身份：访客/);
  assert.equal(h.agents.live.size, 0);
});

test('访问控制：管理员放行；/whoami 显示管理员与话题', async (t) => {
  const h = makeHarness(t, { admins: ['ou_admin'], botOpenId: 'ou_bot', prebindTopic: true });
  await h.bridge.handleInbound(
    inbound('/whoami', {
      chatType: 'group',
      chatId: 'oc_g',
      threadId: 'omt_t',
      senderOpenId: 'ou_admin',
      mentions: ['ou_bot'],
    }),
  );
  const whoami = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(whoami, /你的 open_id：ou_admin/);
  assert.match(whoami, /当前会话：oc_g\[话题 omt_t\]/);
  assert.match(whoami, /身份：管理员/);

  await h.bridge.handleInbound(
    inbound('hi', {
      chatType: 'group',
      chatId: 'oc_g',
      threadId: 'omt_t',
      senderOpenId: 'ou_admin',
      mentions: ['ou_bot'],
    }),
  );
  assert.equal(liveAgent(h).followups.length, 1);
});

test('私聊：/whoami 等文本回复走 sendText，不引用回复', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('/whoami'));
  const sends = h.transport.calls.filter((call) => call.op === 'sendText');
  const replies = h.transport.calls.filter((call) => call.op === 'reply');
  assert.equal(sends.length, 1);
  assert.match(sends[0]?.text ?? '', /你的 open_id/);
  assert.equal(replies.length, 0, 'p2p text must not use reply');
});

test('私聊：普通回合的文本通知/回复走 sendText，不引用回复', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const session = liveAgent(h).session;
  await h.bridge.handleSessionEvent(session, event('turn/start', { turn: 1 }, 100));
  await h.bridge.handleSessionEvent(
    session,
    event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }, 200),
  );
  const replies = h.transport.calls.filter((call) => call.op === 'reply');
  assert.equal(replies.length, 0, 'p2p text must not use reply');
  assert.ok(h.transport.calls.some((call) => call.op === 'sendText'));
});

test('话题：/whoami 走 reply + threadId，不漂到主流程', async (t) => {
  const h = makeHarness(t, { botOpenId: 'ou_bot', prebindTopic: true });
  const msg = inbound('/whoami', {
    chatType: 'group',
    chatId: 'oc_g',
    threadId: 'omt_t',
    senderOpenId: 'ou_user',
    mentions: ['ou_bot'],
  });
  await h.bridge.handleInbound(msg);
  const replies = h.transport.calls.filter(
    (call): call is Extract<TransportCall, { op: 'reply' }> => call.op === 'reply',
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.threadId, 'omt_t');
  assert.equal(replies[0]?.replyTo, msg.messageId);
  assert.ok(!h.transport.calls.some((call) => call.op === 'sendText'));
});

test('/helper 与 /export：markdown 导出写文件并回复 MEDIA', async (t) => {
  const dshHome = tempDshHome(t);
  const h = makeHarness(t, {
    exportProvider: () => ({
      messages: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '你好呀' },
        { role: 'tool', toolName: 'bash', text: 'ok' },
      ],
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/export'));
  const reply = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(reply, /^MEDIA:\/.*\.md/m);
  assert.match(reply, /已导出会话/);
  const path = reply.split('\n')[0]!.slice('MEDIA:'.length);
  const cacheRoot = join(dshHome, 'caduceus', 'cache', 'exports');
  assert.ok(path.startsWith(cacheRoot), `export must live in cache: ${path}`);
  assert.ok(!path.startsWith(h.dir), 'export must not live in the session cwd');
  assert.ok(!path.split(/[\\/]/).at(-1)!.startsWith('.'));
  assert.match(path.split(/[\\/]/).at(-1)!, /^caduceus-[a-z0-9-]+-\d{8}-\d{6}\.md$/);
  assert.ok(existsSync(path), `export file must exist: ${path}`);
  const content = readFileSync(path, 'utf8');
  assert.match(content, /# dsh 会话导出/);
  assert.match(content, /## user/);
  assert.match(content, /## assistant/);
  assert.match(content, /## tool: bash/);
  assert.ok(content.split('\n').length > 0);
  assert.equal(
    h.transport.uploadedFiles.filter((entry) => entry.fileName.endsWith('.md')).length,
    1,
  );
});

test('/export --json：写 .jsonl 并回复 MEDIA', async (t) => {
  tempDshHome(t);
  const h = makeHarness(t, {
    exportProvider: () => ({
      messages: [{ role: 'user', text: '你好' }],
      rawJsonl: '{"type":"user/message","data":{"message":{"content":[{"type":"text","text":"你好"}]}}}\n',
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/export --json'));
  const reply = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(reply, /^MEDIA:\/.*\.jsonl/m);
  const path = reply.split('\n')[0]!.slice('MEDIA:'.length);
  assert.ok(existsSync(path), 'successful upload must not delete the export');
  assert.match(readFileSync(path, 'utf8'), /user\/message/);
});

test('/export：上传失败保留文件并 warn 全路径', async (t) => {
  tempDshHome(t);
  const h = makeHarness(t, {
    exportProvider: () => ({ messages: [{ role: 'user', text: '你好' }] }),
  });
  h.transport.failUploadFileWith = new Error('upload boom');
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/export'));
  const reply = recordedTexts(h.transport).at(-1) ?? '';
  const path = reply.split('\n')[0]!.slice('MEDIA:'.length);
  assert.ok(existsSync(path), 'failed upload must keep the export file');
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'warn' &&
        entry.message.includes('media send failed') &&
        entry.message.includes(path),
    ),
    h.logger.entries.map((entry) => entry.message).join(' | '),
  );
});

test('/export：没有日志 → 明确回复，不写文件', async (t) => {
  tempDshHome(t);
  const h = makeHarness(t, { exportProvider: () => undefined });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/export'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /本会话没有可导出的日志/);
  assert.equal(h.transport.uploadedFiles.length, 0);
});

test('/export：超过 5MB 截断并注明', async (t) => {
  tempDshHome(t);
  const h = makeHarness(t, {
    exportProvider: () => ({
      messages: [{ role: 'assistant', text: 'x'.repeat(6 * 1024 * 1024) }],
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/export'));
  const reply = recordedTexts(h.transport).at(-1) ?? '';
  const path = reply.split('\n')[0]!.slice('MEDIA:'.length);
  const content = readFileSync(path, 'utf8');
  assert.ok(Buffer.byteLength(content, 'utf8') <= 5 * 1024 * 1024);
  assert.match(content, /已截断/);
});


function lastPermissionCardText(transport: FakeTransport): string {
  const card = recordedCards(transport)
    .filter((entry) => entry.card.header?.title.content?.startsWith('权限 · 当前：'))
    .at(-1)?.card;
  return JSON.stringify(card);
}

test('/permission 无参：档位描述来自 resolve（沙箱/审批），含 auto', async (t) => {
  const specs: Record<string, { sandbox: string; approval?: string }> = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    auto: { sandbox: 'auto' },
  };
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['read-only', 'workspace-write', 'danger-full-access', 'auto'],
      current: () => 'workspace-write',
      resolve: (name: string) => specs[name] ?? {},
    }),
  });
  await h.bridge.handleInbound(inbound('/permission'));
  const text = lastPermissionCardText(h.transport);
  assert.match(text, /权限 · 当前：工作区内修改/);
  assert.match(text, /用法：\/permission <档位>，或点下方按钮/);
  for (const label of ['仅可查看', '工作区内修改', '完全权限', '自动审查（EXP）']) {
    assert.match(text, new RegExp(label));
  }
  for (const word of ['沙箱', '审批', 'sandbox', 'approval']) {
    assert.ok(!text.includes(word), `permission card must not contain ${word}`);
  }
});

test('/permission 当前 custom：人话说明 + 回到预设的指引', async (t) => {
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['workspace-write'],
      current: () => 'custom',
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
    }),
  });
  await h.bridge.handleInbound(inbound('/permission'));
  const text = lastPermissionCardText(h.transport);
  assert.match(text, /权限 · 当前：自定义（不匹配任何预设）/);
  assert.match(text, /用法：\/permission <档位>，或点下方按钮/);
  assert.ok(!text.includes('沙箱'));
  assert.ok(!text.includes('审批'));
});

test('/permission resolve 抛错：只显示档位名，不崩', async (t) => {
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['weird'],
      current: () => 'custom',
      resolve: () => {
        throw new Error('boom');
      },
    }),
  });
  await h.bridge.handleInbound(inbound('/permission'));
  const text = lastPermissionCardText(h.transport);
  assert.match(text, /权限 · 当前：自定义（不匹配任何预设）/);
  assert.match(text, /"content":"weird"/);
  assert.ok(!text.includes('沙箱'));
  assert.ok(!text.includes('审批'));
});

test('/permission 切换：调用底层命令一次并翻译为中文', async (t) => {
  const forwarded: string[] = [];
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['read-only', 'workspace-write'],
      current: () => 'read-only',
    }),
    commandRunner: async (_agent, line) => {
      forwarded.push(line);
      return { kind: 'success', text: 'preset workspace-write' };
    },
  });
  await h.bridge.handleInbound(inbound('/permission workspace-write'));
  assert.deepEqual(forwarded, ['/permission workspace-write']);
  assert.match(
    recordedTexts(h.transport).at(-1) ?? '',
    /已切换到 工作区内修改（workspace-write）/,
  );
});

test('/permission 未知档位：中文提示且不调用底层命令', async (t) => {
  const forwarded: string[] = [];
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['read-only', 'workspace-write'],
      current: () => 'workspace-write',
    }),
    commandRunner: async (_agent, line) => {
      forwarded.push(line);
      return { kind: 'success', text: 'preset workspace-write' };
    },
  });
  await h.bridge.handleInbound(inbound('/permission nope'));
  assert.deepEqual(forwarded, []);
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /未知档位 nope，可用：read-only, workspace-write/);
});

test('/permission 服务缺失：透传英文并标注（dsh 原文）', async (t) => {
  const h = makeHarness(t, {
    commandRunner: async (_agent, line) => {
      if (line === '/permission') {
        return { kind: 'success', text: 'current preset workspace-write (available: read-only, workspace-write)' };
      }
      return undefined;
    },
  });
  await h.bridge.handleInbound(inbound('/permission'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /（dsh 原文）/);
  assert.match(text, /current preset workspace-write/);
});

test('/permission 服务缺失 + 带参：透传英文并标注（dsh 原文）', async (t) => {
  const h = makeHarness(t, {
    commandRunner: async (_agent, line) => ({
      kind: 'success',
      text: line.endsWith('read-only') ? 'preset read-only' : 'current preset workspace-write',
    }),
  });
  await h.bridge.handleInbound(inbound('/permission read-only'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /（dsh 原文）/);
  assert.match(text, /preset read-only/);
  assert.ok(!text.includes('已切换到'));
});

test('权限卡片：发送失败 → 同一数据的文本降级', async (t) => {
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['workspace-write'],
      current: () => 'workspace-write',
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
    }),
  });
  h.transport.sendCard = async () => {
    throw new Error('card send boom');
  };
  await h.bridge.handleInbound(inbound('/permission'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /权限 · 当前：工作区内修改/);
  assert.match(text, /用法：\/permission <档位>，或点下方按钮/);
  assert.match(text, /工作区内修改/);
  assert.ok(!text.includes('沙箱'));
  assert.ok(!text.includes('审批'));
});

test('权限卡片：按钮回调执行 /permission 切换并 patch 卡片', async (t) => {
  const forwarded: string[] = [];
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: async () => ({ messageId: 'unused' }),
    updateCard: async () => undefined,
    permissionSwitch: (action, name) => h.bridge.handlePermissionCardAction(action, name),
  });
  const h = makeHarness(t, {
    interactive: runtime,
    commandRunner: async (_agent, line) => {
      forwarded.push(line);
      return { kind: 'success', text: 'preset workspace-write' };
    },
    permissionPresetsProvider: () => ({
      names: ['workspace-write'],
      current: () => 'workspace-write',
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
    }),
  });
  await h.bridge.handleInbound(inbound('/permission'));
  const card = recordedCards(h.transport).find(
    (entry) => entry.card.header?.title.content?.startsWith('权限 · 当前：'),
  );
  assert.ok(card !== undefined);
  const button = buttonsOf(card.card)[0]!;
  await runtime.handleCardAction({
    operatorOpenId: 'ou_user',
    messageId: card.messageId,
    chatId: 'oc_chat',
    value: button.value,
  });
  assert.deepEqual(forwarded, ['/permission workspace-write']);
  assert.ok(
    h.transport.calls.some((call) => call.op === 'updateCard' && call.messageId === card.messageId),
    'permission card must be patched after switching',
  );
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /已切换到 工作区内修改/);
});

test('审批卡片：顶部带当前档位/审批行', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  let h: ReturnType<typeof makeHarness>;
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: (sessionId, card) => h.bridge.sendInteractiveCard(sessionId, card),
    updateCard: async () => undefined,
  });
  const listeners = new Map<string, (...args: any[]) => any>();
  h = makeHarness(t, {
    interactive: runtime,
    rootCtx: {
      on(name: string, listener: (...args: any[]) => any) {
        listeners.set(name, listener);
        return listener;
      },
    },
    permissionPresetsProvider: () => ({
      names: ['workspace-write'],
      current: () => 'workspace-write',
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  const sessionId = liveAgent(h).session.id;
  const promise = listeners.get('approval/request')!(
    { agent: { session: { id: sessionId } }, toolName: 'bash' },
    async () => 'unavailable',
  );
  await tick();
  const card = recordedCards(h.transport).find((entry) =>
    entry.card.header?.title.content.startsWith('审批请求'),
  );
  assert.ok(card !== undefined);
  assert.match(JSON.stringify(card.card), /档位 workspace-write · 审批 人工确认/);
  // resolve it so the pending approval doesn't linger.
  const buttons = buttonsOf(card.card);
  await runtime.handleCardAction({
    operatorOpenId: 'ou_user',
    messageId: card.messageId,
    chatId: 'oc_chat',
    value: buttons[0]!.value,
  });
  assert.equal(await promise, 'allowed-once');
});

test('/status：带当前档位/审批行', async (t) => {
  const h = makeHarness(t, {
    permissionPresetsProvider: () => ({
      names: ['workspace-write'],
      current: () => 'workspace-write',
      resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
    }),
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/status'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /档位 workspace-write · 审批 人工确认/);
});

test('权限卡片：切档后原地刷新为新档位标签', async (t) => {
  let current = 'workspace-write';
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: async () => ({ messageId: 'unused' }),
    updateCard: async () => undefined,
    permissionSwitch: (action, name) => h.bridge.handlePermissionCardAction(action, name),
  });
  const h = makeHarness(t, {
    interactive: runtime,
    commandRunner: async (_agent, line) => {
      if (line === '/permission read-only') {
        current = 'read-only';
        return { kind: 'success', text: 'preset read-only' };
      }
      return { kind: 'success', text: 'preset ' + line.split(' ')[1] };
    },
    permissionPresetsProvider: () => ({
      names: ['read-only', 'workspace-write'],
      current: () => current,
      resolve: () => ({ sandbox: 'read-only', approval: 'ask' }),
    }),
  });
  await h.bridge.handleInbound(inbound('/permission'));
  const card = recordedCards(h.transport).find(
    (entry) => entry.card.header?.title.content?.startsWith('权限 · 当前：'),
  );
  assert.ok(card !== undefined);
  const readOnly = buttonsOf(card.card).find((button) => button.label === '仅可查看');
  assert.ok(readOnly !== undefined);
  await runtime.handleCardAction({
    operatorOpenId: 'ou_user',
    messageId: card.messageId,
    chatId: 'oc_chat',
    value: readOnly.value,
  });
  const patched = h.transport.calls.find(
    (call) => call.op === 'updateCard' && call.messageId === card.messageId,
  );
  assert.ok(patched !== undefined);
  assert.match(JSON.stringify(patched), /权限 · 当前：仅可查看/);
});

function runningProcessCardText(h: ReturnType<typeof makeHarness>): string {
  const card = recordedCards(h.transport)
    .filter((entry) => entry.card.header?.title.content === PROCESS_CARD_TITLE)
    .at(-1);
  assert.ok(card !== undefined);
  const patch = finalPatchOfCard(h.transport, card.messageId);
  return JSON.stringify(patch ?? card.card);
}

async function settleRender(h: ReturnType<typeof makeHarness>): Promise<void> {
  h.clock.advance(400);
  await tick();
}

async function startRunningTurn(h: ReturnType<typeof makeHarness>): Promise<ReturnType<typeof liveAgent>> {
  const agent = liveAgent(h);
  await h.bridge.handleSessionEvent(agent.session, event('turn/start', { turn: 1 }, 100));
  await settleRender(h);
  return agent;
}

test('/usage：从日志聚合本回合/合计（含缓存命中）', async (t) => {
  const events = [
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, totalTokens: 16 } } },
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, totalTokens: 9 } } },
  ];
  const h = makeHarness(t, { usageProvider: () => events });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /本回合：输入 15 · 输出 5 · 缓存命中 5 · 合计 25/);
  assert.match(text, /上回合：暂无/);
  assert.match(text, /会话合计：输入 15 · 输出 5 · 缓存命中 5 · 合计 25/);
});

test('/usage：缺字段按 0 处理', async (t) => {
  const events = [
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 7 } } },
  ];
  const h = makeHarness(t, { usageProvider: () => events });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  assert.match(
    recordedTexts(h.transport).at(-1) ?? '',
    /本回合：输入 7 · 输出 0 · 缓存命中 0 · 合计 7/,
  );
});

test('/usage：日志无 usage → 还没有用量记录', async (t) => {
  const h = makeHarness(t, { usageProvider: () => [] });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  assert.equal(recordedTexts(h.transport).at(-1), '会话里还没有用量记录');
});

test('/usage：多 turn 上回合有值', async (t) => {
  const events = [
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 3, outputTokens: 1 } } },
    { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 4, outputTokens: 2 } } },
  ];
  const h = makeHarness(t, { usageProvider: () => events });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /本回合：输入 4 · 输出 2 · 缓存命中 0 · 合计 6/);
  assert.match(text, /上回合：输入 3 · 输出 1 · 缓存命中 0 · 合计 4/);
  assert.match(text, /会话合计：输入 7 · 输出 3 · 缓存命中 0 · 合计 10/);
});

test('/usage：readSession 抛错 → 读不到会话日志并带原因', async (t) => {
  const h = makeHarness(t, {
    usageProvider: async () => {
      throw new Error('log boom');
    },
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  assert.match(recordedTexts(h.transport).at(-1) ?? '', /读不到会话日志（log boom）/);
});

test('/usage：sessionQuery 缺失 → 读不到会话日志', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  assert.match(
    recordedTexts(h.transport).at(-1) ?? '',
    /读不到会话日志（sessionQuery 服务不可用）/,
  );
});

test('压缩：compaction/start 在过程卡显示“上下文压缩中…”', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await h.bridge.handleSessionEvent(agent.session, event('compaction/start', {}, 150));
  await settleRender(h);
  assert.match(runningProcessCardText(h), /上下文压缩中…/);
});

test('压缩：end 带保留条数；缺字段只写已压缩', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await h.bridge.handleSessionEvent(agent.session, event('compaction/end', { kept: 3 }, 150));
  await settleRender(h);
  assert.match(runningProcessCardText(h), /已压缩 · 保留 3 条/);

  const h2 = makeHarness(t);
  await h2.bridge.handleInbound(inbound('hi'));
  const agent2 = await startRunningTurn(h2);
  await h2.bridge.handleSessionEvent(agent2.session, event('compaction/end', {}, 150));
  await settleRender(h2);
  const text = runningProcessCardText(h2);
  assert.match(text, /已压缩/);
  assert.ok(!text.includes('保留'));
});

test('压缩：end 先于 start 不崩（乱序）', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await assert.doesNotReject(async () => {
    await h.bridge.handleSessionEvent(agent.session, event('compaction/end', {}, 150));
    await h.bridge.handleSessionEvent(agent.session, event('compaction/start', {}, 160));
    await settleRender(h);
  });
});

test('队友：team/member 显示一行；team/task 覆盖同一行不堆叠', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await h.bridge.handleSessionEvent(
    agent.session,
    event('team/member', { member: { name: '研究员', phase: 'running' } }, 150),
  );
  await settleRender(h);
  assert.match(runningProcessCardText(h), /队友 研究员：running/);

  await h.bridge.handleSessionEvent(
    agent.session,
    event('team/task', { task: { subject: '调研', status: 'in_progress' } }, 160),
  );
  await settleRender(h);
  const text = runningProcessCardText(h);
  assert.match(text, /队友 调研：in_progress/);
  assert.ok(!text.includes('队友 研究员'));
});

test('停止按钮：运行中出现在过程卡，payload 正确', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  await startRunningTurn(h);
  const text = runningProcessCardText(h);
  assert.match(text, /caduceus.turn.stop/);
  assert.match(text, /停止/);
});

test('停止按钮：非运行态不出现', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await h.bridge.handleSessionEvent(agent.session, event('turn/end', { reason: { kind: 'completed' } }, 200));
  const text = runningProcessCardText(h);
  assert.ok(!text.includes('caduceus.turn.stop'));
  assert.ok(!text.includes('停止'));
});

test('停止按钮：点击调用 cancel 一次并卡片显示新停止文案。后台任务仍在运行，完成后结果会回来。', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: async () => ({ messageId: 'unused' }),
    updateCard: async () => undefined,
    turnStop: (action) => h.bridge.handleStopCardAction(action),
  });
  const h = makeHarness(t, { interactive: runtime });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  const card = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(card !== undefined);
  await runtime.handleCardAction({
    operatorOpenId: 'ou_user',
    messageId: card.messageId,
    chatId: 'oc_chat',
    value: { action: 'caduceus.turn.stop' },
  });
  assert.equal(agent.cancels.length, 1);
  await settleRender(h);
  assert.match(runningProcessCardText(h), /已停止当前回合。后台任务仍在运行，完成后结果会回来。/);
});

test('停止按钮：连点 1 秒内只 cancel 一次', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: async () => ({ messageId: 'unused' }),
    updateCard: async () => undefined,
    turnStop: (action) => h.bridge.handleStopCardAction(action),
  });
  const h = makeHarness(t, { interactive: runtime });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  const card = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(card !== undefined);
  const action = {
    operatorOpenId: 'ou_user',
    messageId: card.messageId,
    chatId: 'oc_chat',
    value: { action: 'caduceus.turn.stop' },
  };
  await runtime.handleCardAction(action);
  await runtime.handleCardAction(action);
  assert.equal(agent.cancels.length, 1);
});

test('停止按钮：cancel 抛错只记 warn', async (t) => {
  const { InteractiveRuntime } = await import('../src/interactive/runtime.js');
  const runtime = new InteractiveRuntime({
    config: { approvalCard: true, questionCard: true, timeoutMs: 300_000 },
    logger: new FakeLogger(),
    clock: new FakeClock(),
    sendCard: async () => ({ messageId: 'unused' }),
    updateCard: async () => undefined,
    turnStop: (action) => h.bridge.handleStopCardAction(action),
  });
  const h = makeHarness(t, { interactive: runtime });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  agent.cancel = () => {
    throw new Error('cancel boom');
  };
  const card = cardOfTitle(recordedCards(h.transport), PROCESS_CARD_TITLE);
  assert.ok(card !== undefined);
  await runtime.handleCardAction({
    operatorOpenId: 'ou_user',
    messageId: card.messageId,
    chatId: 'oc_chat',
    value: { action: 'caduceus.turn.stop' },
  });
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('stop card failed'),
    ),
  );
  assert.ok(!runningProcessCardText(h).includes('已停止当前回合。后台任务仍在运行，完成后结果会回来。'));
});

test('/usage：日志里多 turn 时上回合有值', async (t) => {
  const h = makeHarness(t, {
    usageProvider: () => [
      { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 3, outputTokens: 1 } } },
      { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 2, outputTokens: 0 } } },
    ],
  });
  await h.bridge.handleInbound(inbound('hi'));
  await h.bridge.handleInbound(inbound('/usage'));
  const text = recordedTexts(h.transport).at(-1) ?? '';
  assert.match(text, /本回合：输入 2 · 输出 0 · 缓存命中 0 · 合计 2/);
  assert.match(text, /上回合：输入 3 · 输出 1 · 缓存命中 0 · 合计 4/);
});

test('压缩：compaction/end error 显示失败，不崩', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await h.bridge.handleSessionEvent(
    agent.session,
    event('compaction/end', { error: 'summary failed' }, 150),
  );
  await settleRender(h);
  assert.match(runningProcessCardText(h), /上下文压缩失败/);
});

test('metrics compact：过程卡显示轮/步/tok/s/累计/缓存', async (t) => {
  const h = makeHarness(t, { metrics: 'compact' });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = liveAgent(h);
  const feed = async (type: string, data: unknown, time: number): Promise<void> => {
    await h.bridge.handleSessionEvent(agent.session, event(type, data, time));
  };
  await feed('turn/start', { turn: 1 }, 1_000);
  await feed('step/start', { turn: 1 }, 1_100);
  await feed('assistant/message', { turn: 1, usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 500, totalTokens: 1_100 } }, 3_000);
  await settleRender(h);
  const text = runningProcessCardText(h);
  assert.match(text, /1 轮 · 1 步 · 50 tok\/s · 1\.1k tok · 缓存 50%/);
  assert.ok(!text.includes('上下文'));
  await feed('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3_000);
});

test('metrics off：过程卡不显示指标', async (t) => {
  const h = makeHarness(t, { metrics: 'off' });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = await startRunningTurn(h);
  await h.bridge.handleSessionEvent(
    agent.session,
    event('assistant/message', { turn: 1, usage: { inputTokens: 5, outputTokens: 5 } }, 200),
  );
  await settleRender(h);
  const text = runningProcessCardText(h);
  assert.ok(!text.includes('tok/s'));
  assert.ok(!text.includes('缓存'));
});

test('metrics detailed：带上下文百分比', async (t) => {
  const h = makeHarness(t, { metrics: 'detailed' });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = liveAgent(h);
  const feed = async (type: string, data: unknown, time: number): Promise<void> => {
    await h.bridge.handleSessionEvent(agent.session, event(type, data, time));
  };
  await feed('turn/start', { turn: 1 }, 1_000);
  await feed('assistant/message', { turn: 1, usage: { inputTokens: 500, cacheReadTokens: 500, outputTokens: 10 } }, 1_500);
  await feed('turn/start', { turn: 2 }, 2_000);
  await feed('request/context', { contextWindow: 10_000 }, 2_100);
  await feed('assistant/message', { turn: 2, usage: { inputTokens: 100, outputTokens: 5 } }, 3_000);
  await settleRender(h);
  assert.match(runningProcessCardText(h), /上下文 10%/);
});

test('metrics detailed：缺 contextWindow 不显示上下文段', async (t) => {
  const h = makeHarness(t, { metrics: 'detailed' });
  await h.bridge.handleInbound(inbound('hi'));
  const agent = liveAgent(h);
  await h.bridge.handleSessionEvent(agent.session, event('turn/start', { turn: 1 }, 1_000));
  await h.bridge.handleSessionEvent(
    agent.session,
    event('assistant/message', { turn: 1, usage: { inputTokens: 100, outputTokens: 5 } }, 2_000),
  );
  await settleRender(h);
  assert.ok(!runningProcessCardText(h).includes('上下文'));
});

test('/stop 命令：使用新的诚实停止文案', async (t) => {
  const h = makeHarness(t);
  await h.bridge.handleInbound(inbound('hi'));
  await startRunningTurn(h);
  await h.bridge.handleInbound(inbound('/stop'));
  assert.equal(
    recordedTexts(h.transport).at(-1),
    '已停止当前回合。后台任务仍在运行，完成后结果会回来。',
  );
});
