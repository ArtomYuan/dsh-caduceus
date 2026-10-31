/**
 * SOUL source candidates and the "source missing is a no-op" contract.
 *
 * Sources are tried in order: `<DSH_HOME>/SOUL.md` then
 * `<DSH_AGENTS_HOME>/SOUL.md` (normally `~/.agents/SOUL.md`). When neither
 * exists, nothing is created or modified and one info line is logged.
 *
 * All paths are temp directories; the real `~/.dsh` / `~/.agents` are never
 * touched.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { LoggerLike } from '../src/logger.js';
import { runPersonaCommand } from '../src/persona/command.js';
import { syncSoul } from '../src/persona/blocks.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-persona-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingLogger(): { logger: LoggerLike; lines: string[] } {
  const lines: string[] = [];
  const logger: LoggerLike = {
    info: (message) => {
      lines.push(message);
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return { logger, lines };
}

function homes(dir: string): { dshHome: string; agentsHome: string } {
  const dshHome = join(dir, 'dsh-home');
  const agentsHome = join(dir, 'agents-home');
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(agentsHome, { recursive: true });
  return { dshHome, agentsHome };
}

test('SOUL 源优先级：<DSH_HOME>/SOUL.md 先于 <AGENTS_HOME>/SOUL.md', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  writeFileSync(join(dshHome, 'SOUL.md'), '第一优先：DSH_HOME\n', 'utf8');
  writeFileSync(join(agentsHome, 'SOUL.md'), '第二优先：AGENTS_HOME\n', 'utf8');

  const result = await syncSoul({
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
  });
  assert.equal(result.status, 'created');
  assert.equal(result.soulFile, join(dshHome, 'SOUL.md'));
  const written = readFileSync(join(agentsHome, 'AGENTS.md'), 'utf8');
  assert.match(written, /第一优先：DSH_HOME/);
  assert.ok(!written.includes('第二优先：AGENTS_HOME'));
});

test('SOUL 源回退：DSH_HOME 没有时使用 <AGENTS_HOME>/SOUL.md', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  writeFileSync(join(agentsHome, 'SOUL.md'), '回退人格：AGENTS_HOME\n', 'utf8');

  const result = await syncSoul({
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
  });
  assert.equal(result.status, 'created');
  assert.equal(result.soulFile, join(agentsHome, 'SOUL.md'));
  assert.match(readFileSync(join(agentsHome, 'AGENTS.md'), 'utf8'), /回退人格：AGENTS_HOME/);
});

test('两个源都缺失：missing + 一行 info「persona source missing」，不建文件', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const { logger, lines } = recordingLogger();

  const result = await syncSoul({
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
    logger,
  });
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.tried, [
    join(dshHome, 'SOUL.md'),
    join(agentsHome, 'SOUL.md'),
  ]);
  assert.equal(existsSync(join(agentsHome, 'AGENTS.md')), false, 'must not create AGENTS.md');
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /^persona source missing/);
});

test('显式 soulFile 不参与回退：指定路径缺失就 missing', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  writeFileSync(join(agentsHome, 'SOUL.md'), '不该被回退使用\n', 'utf8');
  const explicit = join(dir, 'explicit-missing.md');

  const result = await syncSoul({
    soulFile: explicit,
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
  });
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.tried, [explicit]);
  assert.equal(existsSync(join(agentsHome, 'AGENTS.md')), false);
});

test('/persona sync 在两个源缺失时也返回可读提示（不是异常），且不建文件', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const { logger } = recordingLogger();

  const result = await runPersonaCommand('sync', {
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
    logger,
  });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /未找到 SOUL 源/);
  assert.match(result.text, /DSH_HOME|dsh-home/);
  assert.equal(existsSync(join(agentsHome, 'AGENTS.md')), false);
});
