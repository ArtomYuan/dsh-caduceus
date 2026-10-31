/**
 * Persona startup auto-sync: one-shot projection refresh before the first
 * message, idempotent (no rewrite when unchanged), and never fatal.
 *
 * All paths are mkdtemp directories; the real `~/.dsh` / `~/.agents` are never
 * touched.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { LoggerLike } from '../src/logger.js';
import { SOUL_END_MARKER, SOUL_START_MARKER, syncSoul } from '../src/persona/blocks.js';
import { autoSyncPersona } from '../src/persona/auto-sync.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-persona-auto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function homes(dir: string): { dshHome: string; agentsHome: string } {
  const dshHome = join(dir, 'dsh-home');
  const agentsHome = join(dir, 'agents-home');
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(agentsHome, { recursive: true });
  return { dshHome, agentsHome };
}

function recordingLogger(): {
  logger: LoggerLike;
  lines: string[];
  warnings: string[];
} {
  const lines: string[] = [];
  const warnings: string[] = [];
  const logger: LoggerLike = {
    info: (message) => lines.push(message),
    warn: (message) => warnings.push(message),
    error: () => {},
    debug: () => {},
  };
  return { logger, lines, warnings };
}

test('autoSyncPersona：首次调用 sync 一次、写 DSH_HOME/AGENTS.md 并记 synced', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '自动同步人格\n', 'utf8');
  const { logger, lines } = recordingLogger();
  let calls = 0;

  await autoSyncPersona({
    env,
    logger,
    sync: (paths) => {
      calls += 1;
      return syncSoul(paths);
    },
  });

  assert.equal(calls, 1, 'syncSoul must be called exactly once');
  const target = join(dshHome, 'AGENTS.md');
  assert.ok(existsSync(target));
  assert.match(readFileSync(target, 'utf8'), /自动同步人格/);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] as string,
    /^persona: synced soulBytes=\d+ agentsBytes=\d+ status=created$/,
  );
});

test('autoSyncPersona：内容未变 → status=unchanged 且不写盘（mtime 不变）', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '幂等人格\n', 'utf8');
  const { logger, lines } = recordingLogger();

  await autoSyncPersona({ env, logger });
  const target = join(dshHome, 'AGENTS.md');
  const firstContent = readFileSync(target, 'utf8');
  // Stamp an old, recognizable mtime: any rewrite would replace it with "now".
  utimesSync(target, 1_000, 1_000);
  const before = statSync(target).mtimeMs;

  await autoSyncPersona({ env, logger });

  assert.equal(statSync(target).mtimeMs, before, 'unchanged sync must not rewrite the file');
  assert.equal(readFileSync(target, 'utf8'), firstContent);
  assert.ok(
    lines.some((line) => /^persona: synced soulBytes=\d+ agentsBytes=\d+ status=unchanged$/.test(line)),
    lines.join(' | '),
  );
});

test('autoSyncPersona：源缺失 → 不创建 DSH_HOME/AGENTS.md，记 source missing', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const { logger, lines } = recordingLogger();

  await autoSyncPersona({ env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome }, logger });

  assert.equal(existsSync(join(dshHome, 'AGENTS.md')), false);
  assert.equal(existsSync(join(agentsHome, 'AGENTS.md')), false);
  assert.ok(lines.includes('persona: source missing; skipped'), lines.join(' | '));
});

test('autoSyncPersona：目标标记损坏 → 不写、warn、启动继续', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '人格\n', 'utf8');
  const target = join(dshHome, 'AGENTS.md');
  const broken = `# 全局\n${SOUL_START_MARKER}\n单边标记\n`;
  writeFileSync(target, broken, 'utf8');
  const { logger, warnings } = recordingLogger();

  await autoSyncPersona({ env, logger });

  assert.equal(readFileSync(target, 'utf8'), broken);
  assert.ok(warnings.includes('persona: sync skipped (malformed)'), warnings.join(' | '));
});

test('autoSyncPersona：personaAutoSync=false → 零调用', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  let calls = 0;
  const { logger, lines, warnings } = recordingLogger();

  await autoSyncPersona({
    enabled: false,
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
    logger,
    sync: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(lines, []);
  assert.deepEqual(warnings, []);
});

test('autoSyncPersona：异常被捕获，只记一行 warn，不抛错', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const { logger, warnings } = recordingLogger();

  await autoSyncPersona({
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
    logger,
    sync: async () => {
      throw new Error('boom');
    },
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /^persona auto-sync failed: boom$/);
});

test('autoSyncPersona 保留块外内容（复用既有 upsert 语义）', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const target = join(dshHome, 'AGENTS.md');
  writeFileSync(join(dshHome, 'SOUL.md'), '新人格\n', 'utf8');
  const prefix = '# 用户指令\n\n不要动。\n\n';
  writeFileSync(target, `${prefix}${SOUL_START_MARKER}\n旧人格\n${SOUL_END_MARKER}\n`, 'utf8');
  const { logger } = recordingLogger();

  await autoSyncPersona({ env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome }, logger });

  const content = readFileSync(target, 'utf8');
  assert.ok(content.startsWith(prefix));
  assert.match(content, /新人格/);
  assert.ok(!content.includes('旧人格'));
});
