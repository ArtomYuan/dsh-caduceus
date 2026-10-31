#!/usr/bin/env node
/**
 * dsh-caduceus slice-1 smoke check.
 *
 * Exercises the built `dist/` modules end to end without a running dsh and
 * without touching `~/.dsh`: every path used here lives under a `mkdtemp`
 * directory. Run `pnpm build` first.
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

const dir = await mkdtemp(join(tmpdir(), 'dsh-caduceus-smoke-'));
try {
  // 1. Scope keys: two topics of one chat are two distinct keys; a chat without
  //    a topic falls back to the plain chat id.
  const topicA = scopeKey('oc_smoke', 'omt_a');
  const topicB = scopeKey('oc_smoke', 'omt_b');
  assert.equal(topicA, `oc_smoke${SCOPE_KEY_SEPARATOR}omt_a`);
  assert.notEqual(topicA, topicB);
  assert.equal(scopeKey('oc_smoke'), 'oc_smoke');

  // 2. Command classification: seven owned commands, everything else passes
  //    through with the original bytes.
  assert.deepEqual([...COMMAND_NAMES], ['new', 'sessions', 'rename', 'resume', 'stop', 'persona', 'help']);
  assert.deepEqual(parseCommand('/new'), { kind: 'new' });
  assert.deepEqual(parseCommand('/compact'), { kind: 'passthrough', raw: '/compact' });
  assert.deepEqual(parseCommand('普通消息'), { kind: 'passthrough', raw: '普通消息' });

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
  const leftovers = await readFile(mapPath, 'utf8');
  assert.ok(!leftovers.includes('"tmp"'));

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
  const again = await syncSoul({ soulFile, agentsFile });
  assert.equal(again.status, 'unchanged');
  const shown = await readSoul({ soulFile, agentsFile });
  assert.equal(shown.status, 'present');
  assert.equal(shown.content, '你是 Hermes。');

  console.log('smoke ok: scopeKey / parseCommand / truncateCardContent / SessionStore v3 / persona sync');
} finally {
  await rm(dir, { recursive: true, force: true });
}
