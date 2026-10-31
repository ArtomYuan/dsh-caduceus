#!/usr/bin/env node
/**
 * dsh-caduceus smoke check (slice 1 pure logic + slice 2 transport/status/bridge).
 *
 * Exercises the built `dist/` modules end to end without a running dsh, without
 * Feishu credentials, and without touching `~/.dsh`: every path used here lives
 * under a `mkdtemp` directory. Run `pnpm build` first.
 *
 * Usage: node scripts/smoke.mjs   (or: pnpm smoke)
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const load = (relative) => import(new URL(relative, dist).href);

const { SCOPE_KEY_SEPARATOR, SESSION_MAP_VERSION, SessionStore, scopeKey } = await load('session-key.js');
const { COMMAND_NAMES, parseCommand } = await load('commands/parse.js');
const { truncateCardContent } = await load('render/truncate.js');
const { SOUL_END_MARKER, SOUL_START_MARKER, readSoul, syncSoul } = await load('persona/blocks.js');
const { FeishuApiError, normalizeMessageEvent, ReliableTransport } = await load('transport/index.js');
const { StatusTracker, shouldNotifyTerminal, terminalNotice } = await load('status.js');
const { CARD_BYTE_LIMIT, cardByteSize, progressCard } = await load('render/index.js');
const { Bridge } = await load('bridge/index.js');

const dir = await mkdtemp(join(tmpdir(), 'dsh-caduceus-smoke-'));
try {
  // 1. Scope keys: two topics of one chat are two distinct keys; a chat without
  //    a topic falls back to the plain chat id.
  const topicA = scopeKey('oc_smoke', 'omt_a');
  const topicB = scopeKey('oc_smoke', 'omt_b');
  assert.equal(topicA, `oc_smoke${SCOPE_KEY_SEPARATOR}omt_a`);
  assert.notEqual(topicA, topicB);
  assert.equal(scopeKey('oc_smoke'), 'oc_smoke');

  // 2. Command classification: eight owned commands, everything else passes
  //    through with the original bytes.
  assert.deepEqual([...COMMAND_NAMES], ['new', 'sessions', 'rename', 'resume', 'stop', 'status', 'persona', 'help']);
  assert.deepEqual(parseCommand('/new'), { kind: 'new' });
  assert.deepEqual(parseCommand('/status'), { kind: 'status' });
  assert.deepEqual(parseCommand('/compact'), { kind: 'passthrough', raw: '/compact' });
  assert.deepEqual(parseCommand('/export'), { kind: 'passthrough', raw: '/export' });

  // 3. Truncation: keep a UTF-8-safe tail and say how much was dropped.
  const long = '汉😀'.repeat(4000);
  const cut = truncateCardContent(long, { maxBytes: 100 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.keptBytes <= 100);
  assert.ok(!cut.text.includes('\uFFFD'));
  assert.ok(cut.text.includes(`已省略 ${cut.omittedChars} 字符`));

  // 4. Session map: v3 file, atomic write (no .tmp left behind).
  const mapPath = join(dir, 'caduceus', 'session-map.json');
  const store = new SessionStore({ filePath: mapPath });
  store.load();
  const first = store.ensure(topicA, () => 'feishu-1000');
  const second = store.ensure(topicB, () => 'feishu-1001');
  assert.notEqual(first, second);
  assert.equal(store.get(topicA), 'feishu-1000');
  const rawMap = JSON.parse(await readFile(mapPath, 'utf8'));
  assert.equal(rawMap.version, SESSION_MAP_VERSION);
  assert.deepEqual(rawMap.entries[topicA], { sessionId: 'feishu-1000' });
  assert.ok(!(await readFile(mapPath, 'utf8')).includes('"tmp"'));

  // 5. Persona block: only the marked region changes, repeat sync is a no-op.
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, '.agents', 'AGENTS.md');
  const preamble = '# 用户全局\n\n前置内容，必须逐字节保留。\n\n';
  await mkdir(join(dir, '.agents'), { recursive: true });
  await writeFile(soulFile, '你是 Hermes。\n', 'utf8');
  await writeFile(agentsFile, preamble, 'utf8');
  const created = await syncSoul({ soulFile, agentsFile });
  assert.equal(created.status, 'updated');
  const patched = await readFile(agentsFile, 'utf8');
  assert.ok(patched.startsWith(preamble));
  assert.ok(patched.includes(SOUL_START_MARKER) && patched.includes(SOUL_END_MARKER));
  assert.equal((await syncSoul({ soulFile, agentsFile })).status, 'unchanged');
  const shown = await readSoul({ soulFile, agentsFile });
  assert.equal(shown.status, 'present');
  assert.equal(shown.content, '你是 Hermes。');

  // 5b. SOUL source fallback: ~/.agents/SOUL.md is used when DSH_HOME/SOUL.md
  //     is absent; with neither source present the sync is a no-op and logs one
  //     info line (no file created).
  const fallbackHome = join(dir, 'fallback-dsh');
  const fallbackAgents = join(dir, 'fallback-agents');
  await mkdir(fallbackHome, { recursive: true });
  await mkdir(fallbackAgents, { recursive: true });
  await writeFile(join(fallbackAgents, 'SOUL.md'), '回退人格。\n', 'utf8');
  const fallbackLogs = [];
  const fallbackSync = await syncSoul({
    env: { DSH_HOME: fallbackHome, DSH_AGENTS_HOME: fallbackAgents },
    logger: { info: (m) => fallbackLogs.push(m), warn() {}, error() {}, debug() {} },
  });
  assert.equal(fallbackSync.status, 'created');
  assert.equal(fallbackSync.soulFile, join(fallbackAgents, 'SOUL.md'));
  const missingHome = join(dir, 'missing-dsh');
  const missingAgents = join(dir, 'missing-agents');
  await mkdir(missingHome, { recursive: true });
  await mkdir(missingAgents, { recursive: true });
  const missingLogs = [];
  const missingSync = await syncSoul({
    env: { DSH_HOME: missingHome, DSH_AGENTS_HOME: missingAgents },
    logger: { info: (m) => missingLogs.push(m), warn() {}, error() {}, debug() {} },
  });
  assert.equal(missingSync.status, 'missing');
  assert.ok(missingLogs.some((line) => line.startsWith('persona source missing')));

  // 6. Normalization keeps the topic (thread_id wins over root_id) and drops
  //    non-human senders before anything else.
  const botEvent = normalizeMessageEvent({
    sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' },
    message: {
      message_id: 'om_bot',
      chat_id: 'oc_smoke',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '自我改进通知' }),
    },
  });
  assert.equal(botEvent, undefined);
  const normalized = normalizeMessageEvent({
    sender: { sender_id: { open_id: 'ou_smoke' }, sender_type: 'user' },
    message: {
      message_id: 'om_smoke',
      chat_id: 'oc_smoke',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
      thread_id: 'omt_thread',
      root_id: 'om_root',
    },
  });
  assert.equal(normalized.threadId, 'omt_thread');

  // 7. Reliable transport: 230071 degrades to chat_id with the same uuid.
  const apiCalls = { created: [], replied: [], patched: [] };
  let uuidSeq = 0;
  const api = {
    async start() {},
    async stop() {},
    onMessage() {},
    async createMessage(input) {
      apiCalls.created.push(input);
      return { messageId: `created-${apiCalls.created.length}` };
    },
    async replyMessage(input) {
      apiCalls.replied.push(input);
      throw new FeishuApiError('reply failed', 230071);
    },
    async patchCard(messageId, card) {
      apiCalls.patched.push({ messageId, card });
    },
  };
  const reliable = new ReliableTransport(api, { uuidFactory: () => `uuid-${++uuidSeq}` });
  const sent = await reliable.reply(
    'oc_smoke',
    'om_smoke',
    { kind: 'text', text: '降级' },
    { threadId: 'omt_thread' },
  );
  assert.equal(sent.messageId, 'created-1');
  assert.equal(apiCalls.created.length, 1);
  assert.equal(apiCalls.created[0].uuid, apiCalls.replied[0].uuid);

  // 8. Status: running → failed on error, with steps and a proactive notice.
  const tracker = new StatusTracker();
  tracker.apply({ type: 'turn/start', data: { turn: 1 }, time: 1 });
  tracker.apply({ type: 'step/start', data: { turn: 1, step: 1 }, time: 2 });
  tracker.apply({ type: 'step/start', data: { turn: 1, step: 2 }, time: 3 });
  tracker.apply({
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } },
    time: 4,
  });
  const status = tracker.get();
  assert.equal(status.state, 'failed');
  assert.equal(status.steps, 2);
  assert.equal(shouldNotifyTerminal(status.terminalKind), true);
  assert.match(terminalNotice(status.terminalKind, status.errorMessage), /boom/);

  // 9. Cards: update_multi + 30 KB cap under a huge tail.
  const card = progressCard({
    title: '过程',
    stateLabel: '运行中',
    steps: 1,
    tools: 0,
    tail: '汉😀'.repeat(6000),
  });
  assert.equal(card.config.update_multi, true);
  assert.ok(cardByteSize(card) <= CARD_BYTE_LIMIT);
  assert.match(JSON.stringify(card), /已省略 \d+ 字符/);

  // 10. Bridge end to end with inline fakes: a turn ends with a NEW final message.
  const calls = [];
  const transport = {
    async start() {},
    async stop() {},
    onMessage(handler) {
      this.handler = handler;
    },
    async sendText(chatId, text) {
      calls.push({ op: 'sendText', messageId: `m-${calls.length + 1}`, chatId, text });
      return { messageId: `m-${calls.length}` };
    },
    async sendCard(chatId, card) {
      calls.push({ op: 'sendCard', messageId: `m-${calls.length + 1}`, chatId, card });
      return { messageId: `m-${calls.length}` };
    },
    async updateCard(messageId, card) {
      calls.push({ op: 'updateCard', messageId, card });
    },
    async reply(chatId, messageId, payload) {
      calls.push({ op: 'reply', messageId: `m-${calls.length + 1}`, chatId, replyTo: messageId, payload });
      return { messageId: `m-${calls.length}` };
    },
  };
  const fakeAgents = {
    live: new Map(),
    async create({ sessionId }) {
      const agent = {
        id: sessionId,
        session: { id: sessionId },
        followups: [],
        steers: [],
        cancels: [],
        followup(message) {
          this.followups.push(message);
        },
        steer(message) {
          this.steers.push(message);
        },
        cancel(cause) {
          this.cancels.push(cause);
        },
      };
      this.live.set(sessionId, agent);
      return { agent };
    },
    async resume() {
      throw new Error('smoke does not resume');
    },
    get(sessionId) {
      return this.live.get(sessionId);
    },
  };
  const bridgeStore = new SessionStore({ filePath: join(dir, 'bridge', 'session-map.json') });
  bridgeStore.load();
  const bridge = new Bridge({
    transport,
    sessionMap: bridgeStore,
    agents: fakeAgents,
    config: {
      defaultCwd: dir,
      allowedChats: [],
      allowedUsers: [],
      cardThrottleMs: 400,
      busyMode: 'queue',
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await bridge.handleInbound({
    messageId: 'om_bridge',
    chatId: 'oc_bridge',
    chatType: 'p2p',
    senderOpenId: 'ou_bridge',
    text: '跑一轮',
    createdAt: 0,
  });
  const session = [...fakeAgents.live.values()][0].session;
  await bridge.handleSessionEvent(session, { type: 'turn/start', data: { turn: 1 }, time: 10 });
  await bridge.handleSessionEvent(session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'smoke 输出' }] } },
    time: 20,
  });
  await bridge.handleSessionEvent(session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    time: 30,
  });
  const final = calls.find(
    (call) => call.op === 'reply' && call.payload.kind === 'text' && call.payload.text === 'smoke 输出',
  );
  assert.ok(final, 'final answer must be a new message');
  assert.ok(calls.some((call) => call.op === 'sendCard' || (call.op === 'reply' && call.payload.kind === 'card')));

  // 11. Group gate: a group message without a bot mention is dropped even when
  //     the topic already has a session (no topic exemption anymore).
  const followupsBefore = [...fakeAgents.live.values()][0].followups.length;
  await bridge.handleInbound({
    messageId: 'om_group_no_mention',
    chatId: 'oc_bridge',
    chatType: 'group',
    senderOpenId: 'ou_bridge',
    threadId: 'omt_bridge',
    text: '群里没 @',
    createdAt: 0,
  });
  assert.equal(
    [...fakeAgents.live.values()][0].followups.length,
    followupsBefore,
    'group message without mention must be dropped',
  );

  console.log(
    'smoke ok: scopeKey / parseCommand / truncate / SessionStore v3 / persona / transport(thread+fallback) / status / cards / bridge-final',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
