/**
 * Durable-session existence check used for ghost markers.
 * Layouts are built in mkdtemp; the real `~/.dsh` is never touched.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { hasSessionLog } from '../src/session-files.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-session-files-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('hasSessionLog：存在 session.v*.jsonl* 视为已落地', (t) => {
  const root = makeDir(t);
  const sessionId = 'feishu-1793460837083';
  mkdirSync(join(root, '--home-artom--', sessionId), { recursive: true });
  writeFileSync(join(root, '--home-artom--', sessionId, 'session.v4.jsonl.zstd'), 'x');
  assert.equal(hasSessionLog(sessionId, { root }), true);
});

test('hasSessionLog：目录存在但无 JSONL 文件 / 无目录 / 非法 id 都视为未落地', (t) => {
  const root = makeDir(t);
  const withDir = 'feishu-1111111111111';
  mkdirSync(join(root, 'bucket', withDir), { recursive: true });
  assert.equal(hasSessionLog(withDir, { root }), false);

  assert.equal(hasSessionLog('feishu-2222222222222', { root }), false);
  assert.equal(hasSessionLog('../../etc/passwd', { root }), false);
  assert.equal(hasSessionLog('feishu-3333333333333', { root: join(root, 'missing') }), false);
});
