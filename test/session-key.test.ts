/**
 * Session key + durable map tests.
 *
 * Every test uses a `mkdtemp` directory; the real `~/.dsh` is never read or
 * written. Path-resolution tests inject a fake environment object.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { agentsHome, defaultSessionMapPath, dshHome } from '../src/home.js';
import {
  SCOPE_KEY_SEPARATOR,
  SESSION_MAP_VERSION,
  SessionStore,
  mintSessionId,
  scopeKey,
} from '../src/session-key.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function counterMinter(): () => string {
  let next = 1000;
  return () => `feishu-${next++}`;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

test('scopeKey: 同群两个话题 → 两个不同的键，含 NUL 分隔符', () => {
  const topicA = scopeKey('oc_x', 'omt_a');
  const topicB = scopeKey('oc_x', 'omt_b');
  assert.equal(topicA, `oc_x${SCOPE_KEY_SEPARATOR}omt_a`);
  assert.equal(topicB, `oc_x${SCOPE_KEY_SEPARATOR}omt_b`);
  assert.notEqual(topicA, topicB);
  assert.equal(topicA.split(SCOPE_KEY_SEPARATOR).length, 2);
});

test('scopeKey: 无话题回落到 chatId；空/ null/ undefined thread 同样回落', () => {
  assert.equal(scopeKey('oc_x'), 'oc_x');
  assert.equal(scopeKey('oc_x', null), 'oc_x');
  assert.equal(scopeKey('oc_x', undefined), 'oc_x');
  assert.equal(scopeKey('oc_x', ''), 'oc_x');
});

test('scopeKey: 空 chatId 直接抛错', () => {
  assert.throws(() => scopeKey(''), TypeError);
});

test('默认路径只依赖注入的 env，不读真实 ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: '/tmp/fake-dsh' }), '/tmp/fake-dsh');
  assert.equal(dshHome({ HOME: '/home/fake' }), '/home/fake/.dsh');
  assert.equal(defaultSessionMapPath({ DSH_HOME: '/tmp/fake-dsh' }), '/tmp/fake-dsh/caduceus/session-map.json');
  assert.equal(agentsHome({ DSH_HOME: '/tmp/fake-dsh' }), resolve('/tmp/fake-dsh', '..', '.agents'));
  assert.equal(agentsHome({ DSH_AGENTS_HOME: '/tmp/fake-agents' }), '/tmp/fake-agents');
});

test('mintSessionId: 形如 feishu-<epoch-ms> 且进程内单调不重复', () => {
  const first = mintSessionId();
  const second = mintSessionId();
  assert.match(first, /^feishu-\d+$/);
  assert.match(second, /^feishu-\d+$/);
  assert.notEqual(first, second);
});

test('SessionStore: 同话题两次 ensure 同一 sessionId，重启后仍然一致', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'caduceus', 'session-map.json');
  const key = scopeKey('oc_x', 'omt_a');

  const first = new SessionStore({ filePath, mint: counterMinter() });
  first.load();
  const sessionId = first.ensure(key);
  assert.equal(sessionId, 'feishu-1000');
  assert.equal(first.ensure(key), sessionId);

  const reopened = new SessionStore({ filePath });
  reopened.load();
  assert.equal(reopened.get(key), sessionId);
});

test('SessionStore: 同群两话题 → 两个 sessionId', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'session-map.json');
  const store = new SessionStore({ filePath, mint: counterMinter() });
  store.load();
  const topicA = store.ensure(scopeKey('oc_x', 'omt_a'));
  const topicB = store.ensure(scopeKey('oc_x', 'omt_b'));
  const plain = store.ensure('oc_x');
  assert.notEqual(topicA, topicB);
  assert.notEqual(topicA, plain);
  assert.equal(new Set([topicA, topicB, plain]).size, 3);
});

test('SessionStore: 原子写 —— 先写 .tmp 再 rename，落盘后无残留且权限 0600', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'caduceus', 'session-map.json');
  const store = new SessionStore({ filePath, mint: counterMinter() });
  store.load();
  store.set('oc_x', 'feishu-1');

  assert.deepEqual(readdirSync(join(dir, 'caduceus')), ['session-map.json']);
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  const raw = readFileSync(filePath, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(readJson(filePath)['version'], SESSION_MAP_VERSION);
});

test('SessionStore: v2 扁平映射 → 原样保留旧键，load 不改写，persist 升级 v3', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'session-map.json');
  const topicKey = `oc_x${SCOPE_KEY_SEPARATOR}omt_y`;
  const legacy = {
    [topicKey]: 'feishu-1793313252045',
    oc_plain: 'feishu-1793313252000',
  };
  writeFileSync(filePath, JSON.stringify(legacy), 'utf8');

  const store = new SessionStore({ filePath, mint: counterMinter() });
  store.load();
  assert.deepEqual(store.warnings, []);
  assert.equal(store.get(topicKey), 'feishu-1793313252045');
  assert.equal(store.get('oc_plain'), 'feishu-1793313252000');

  // load() must not rewrite the legacy file.
  assert.deepEqual(readJson(filePath), legacy);

  store.set('oc_new', 'feishu-3');
  const upgraded = readJson(filePath);
  assert.equal(upgraded['version'], SESSION_MAP_VERSION);
  const entries = upgraded['entries'] as Record<string, { sessionId: string }>;
  assert.deepEqual(entries[topicKey], { sessionId: 'feishu-1793313252045' });
  assert.deepEqual(entries['oc_plain'], { sessionId: 'feishu-1793313252000' });
  assert.deepEqual(entries['oc_new'], { sessionId: 'feishu-3' });
  assert.deepEqual(upgraded['cwd'], {});
});

test('SessionStore: 带 version:2 的旧文件同样迁移', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'session-map.json');
  writeFileSync(filePath, JSON.stringify({ version: 2, oc_x: 'feishu-7' }), 'utf8');
  const store = new SessionStore({ filePath });
  store.load();
  assert.equal(store.get('oc_x'), 'feishu-7');
  assert.deepEqual(store.warnings, []);
  assert.deepEqual(store.snapshot().entries, { oc_x: { sessionId: 'feishu-7' } });
});

test('SessionStore: v1（sessions / cwd 两表）迁移，persist 后写 v3', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'session-map.json');
  writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      sessions: { oc_legacy: 'feishu-7' },
      cwd: { oc_legacy: '/home/artom/agent-workspace' },
    }),
    'utf8',
  );
  const store = new SessionStore({ filePath });
  store.load();
  assert.equal(store.get('oc_legacy'), 'feishu-7');
  assert.equal(store.getCwd('oc_legacy'), '/home/artom/agent-workspace');

  store.persist();
  const upgraded = readJson(filePath);
  assert.equal(upgraded['version'], SESSION_MAP_VERSION);
  assert.deepEqual(upgraded['cwd'], { oc_legacy: '/home/artom/agent-workspace' });
});

test('SessionStore: 损坏 JSON 不抛错、留警告、空表启动', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'session-map.json');
  writeFileSync(filePath, '{ this is not json', 'utf8');
  const store = new SessionStore({ filePath });
  assert.doesNotThrow(() => store.load());
  assert.equal(store.size, 0);
  assert.equal(store.warnings.length, 1);
  assert.match(store.warnings[0] as string, /not valid JSON/);
});

test('SessionStore: 文件缺失 → 空表启动，ensure 铸出默认格式 id', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'caduceus', 'session-map.json');
  const store = new SessionStore({ filePath });
  store.load();
  assert.equal(store.size, 0);
  assert.deepEqual(store.warnings, []);
  const first = store.ensure(scopeKey('oc_x', 'omt_a'));
  const second = store.ensure(scopeKey('oc_x', 'omt_b'));
  assert.match(first, /^feishu-\d+$/);
  assert.notEqual(first, second);
  assert.equal(readJson(filePath)['version'], SESSION_MAP_VERSION);
});

test('SessionStore: cwd 独立成表，与 entries 互不影响', (t) => {
  const dir = makeDir(t);
  const filePath = join(dir, 'session-map.json');
  const key = scopeKey('oc_x', 'omt_a');
  const store = new SessionStore({ filePath, mint: counterMinter() });
  store.load();
  store.setCwd(key, '/home/artom/agent-workspace');
  assert.equal(store.getCwd(key), '/home/artom/agent-workspace');
  assert.equal(store.get(key), undefined);

  const reopened = new SessionStore({ filePath });
  reopened.load();
  assert.equal(reopened.getCwd(key), '/home/artom/agent-workspace');
  assert.equal(reopened.get(key), undefined);
  const raw = readJson(filePath);
  assert.deepEqual(raw['cwd'], { [key]: '/home/artom/agent-workspace' });
  assert.deepEqual(raw['entries'], {});
});

test('SessionStore: 未 load 就读写抛错（防止空表覆盖磁盘）', (t) => {
  const dir = makeDir(t);
  const store = new SessionStore({ filePath: join(dir, 'session-map.json') });
  assert.throws(() => store.get('oc_x'), /load\(\)/);
  assert.throws(() => store.set('oc_x', 'feishu-1'), /load\(\)/);
  assert.throws(() => store.persist(), /load\(\)/);
});
