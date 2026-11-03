/** Export cache: readable names under the cache dir + startup cleanup. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { cleanupExportCache, writeExportFile } from '../src/export.js';
import { FakeLogger } from './support/fakes.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-export-cache-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('writeExportFile：缓存目录、文件名可读且不以点开头', (t) => {
  const dir = makeDir(t);
  const path = writeExportFile(
    dir,
    'p2p',
    'feishu-1793650911',
    'md',
    '# hi',
    Date.UTC(2026, 10, 3, 4, 30, 11),
  );
  assert.equal(path.startsWith(dir), true);
  const name = basename(path);
  assert.equal(name.startsWith('.'), false);
  assert.match(name, /^caduceus-p2p-93650911-\d{8}-\d{6}\.md$/);
  assert.equal(readFileSync(path, 'utf8'), '# hi');
});

test('writeExportFile：jsonl 同一命名规则', (t) => {
  const dir = makeDir(t);
  const path = writeExportFile(
    dir,
    'group-user',
    'feishu-abcdef1234567890',
    'jsonl',
    '{"a":1}\n',
    Date.UTC(2026, 10, 3, 5),
  );
  assert.match(basename(path), /^caduceus-group-user-34567890-\d{8}-\d{6}\.jsonl$/);
});

test('cleanup：超龄删除、未超龄保留', (t) => {
  const dir = makeDir(t);
  const oldPath = writeExportFile(dir, 'p2p', 'feishu-old', 'md', 'old', Date.now());
  const freshPath = writeExportFile(dir, 'p2p', 'feishu-fresh', 'md', 'new', Date.now());
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(oldPath, old, old);
  const result = cleanupExportCache(dir, 24, Date.now());
  assert.deepEqual(result, { removed: 1, kept: 1 });
  assert.throws(() => statSync(oldPath));
  assert.ok(statSync(freshPath).isFile());
});

test('cleanup：目录不存在不崩，返回 0/0', () => {
  const result = cleanupExportCache(join(tmpdir(), 'no-such-export-dir-xyz'), 24);
  assert.deepEqual(result, { removed: 0, kept: 0 });
});

test('cleanup：读目录抛错只 warn，不抛', (t) => {
  const dir = makeDir(t);
  const notDir = join(dir, 'not-a-dir');
  writeFileSync(notDir, 'x');
  const logger = new FakeLogger();
  const result = cleanupExportCache(notDir, 24, Date.now(), logger);
  assert.deepEqual(result, { removed: 0, kept: 0 });
  assert.ok(
    logger.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('export cache cleanup failed'),
    ),
  );
});

test('cleanup：日志 removed/kept 计数', (t) => {
  const dir = makeDir(t);
  const oldPath = writeExportFile(dir, 'p2p', 'feishu-old2', 'md', 'old', Date.now());
  writeExportFile(dir, 'p2p', 'feishu-new2', 'md', 'new', Date.now());
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(oldPath, old, old);
  const logger = new FakeLogger();
  cleanupExportCache(dir, 24, Date.now(), logger);
  assert.ok(
    logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'export cache: removed=1 kept=1',
    ),
  );
});

test('cleanup：忽略非 caduceus- 文件', (t) => {
  const dir = makeDir(t);
  const other = join(dir, 'notes.md');
  writeFileSync(other, 'keep');
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(other, old, old);
  cleanupExportCache(dir, 24, Date.now());
  assert.ok(statSync(other).isFile());
});

test('cleanup：maxAge 内保留（边界内）', (t) => {
  const dir = makeDir(t);
  const path = writeExportFile(dir, 'p2p', 'feishu-boundary', 'md', 'x', Date.now());
  const almost = new Date(Date.now() - 23 * 3600 * 1000);
  utimesSync(path, almost, almost);
  const result = cleanupExportCache(dir, 24, Date.now());
  assert.deepEqual(result, { removed: 0, kept: 1 });
});
