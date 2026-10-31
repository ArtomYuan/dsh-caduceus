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
import { defaultAgentsFile, legacyAgentsFile } from '../src/home.js';
import { runPersonaCommand } from '../src/persona/command.js';
import { syncSoul } from '../src/persona/blocks.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-persona-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recordingLogger(): {
  logger: LoggerLike;
  lines: string[];
  warnings: string[];
} {
  const lines: string[] = [];
  const warnings: string[] = [];
  const logger: LoggerLike = {
    info: (message) => {
      lines.push(message);
    },
    warn: (message) => {
      warnings.push(message);
    },
    error: () => {},
    debug: () => {},
  };
  return { logger, lines, warnings };
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
  const written = readFileSync(join(dshHome, 'AGENTS.md'), 'utf8');
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
  assert.match(readFileSync(join(dshHome, 'AGENTS.md'), 'utf8'), /回退人格：AGENTS_HOME/);
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
  assert.equal(existsSync(join(dshHome, 'AGENTS.md')), false, 'must not create AGENTS.md');
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
  assert.equal(existsSync(join(dshHome, 'AGENTS.md')), false);
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
  assert.equal(existsSync(join(dshHome, 'AGENTS.md')), false);
});

test('默认目标解析：<DSH_HOME>/AGENTS.md；旧位置仅作为 legacy 检测', () => {
  const env = { DSH_HOME: '/tmp/dsh-home-x', DSH_AGENTS_HOME: '/tmp/agents-home-x' };
  assert.equal(defaultAgentsFile(env), '/tmp/dsh-home-x/AGENTS.md');
  assert.equal(legacyAgentsFile(env), '/tmp/agents-home-x/AGENTS.md');
});

test('/persona sync 回显 status/soulBytes/agentsBytes 与真实目标路径', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  writeFileSync(join(dshHome, 'SOUL.md'), '回显人格\n', 'utf8');

  const result = await runPersonaCommand('sync', {
    env: { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome },
  });
  assert.equal(result.kind, 'success');
  assert.match(result.text, /status=created/);
  assert.match(result.text, /soulBytes=\d+/);
  assert.match(result.text, /agentsBytes=\d+/);
  assert.ok(result.text.includes(join(dshHome, 'AGENTS.md')));
  assert.match(result.text, /存在/);
});

test('/persona status 显示真实目标文件绝对路径与存在性', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '状态人格\n', 'utf8');
  const target = join(dshHome, 'AGENTS.md');
  writeFileSync(target, '# 用户全局\n', 'utf8');

  const absent = await runPersonaCommand('show', { env });
  assert.ok(absent.text.includes(target));
  assert.match(absent.text, /目标：.*（存在）/);

  await runPersonaCommand('sync', { env });
  const present = await runPersonaCommand('show', { env });
  assert.ok(present.text.includes(target));
  assert.match(present.text, /（存在）/);
  assert.match(present.text, /状态人格/);
});

test('遗留块检测：旧位置有标记块 → 提示但不动文件，目标写 DSH_HOME', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '新位置人格\n', 'utf8');
  const legacy = join(agentsHome, 'AGENTS.md');
  const legacyText = `# 旧指令\n\n<!-- dsh-caduceus:soul:start -->\n旧人格\n<!-- dsh-caduceus:soul:end -->\n`;
  writeFileSync(legacy, legacyText, 'utf8');

  const { logger, warnings } = recordingLogger();
  const result = await runPersonaCommand('sync', { env, logger });
  assert.match(result.text, /发现遗留块在/);
  assert.ok(result.text.includes(legacy));
  assert.ok(warnings.some((line) => line.includes(legacy)));
  assert.equal(readFileSync(legacy, 'utf8'), legacyText, 'legacy file must stay byte-identical');
  assert.match(readFileSync(join(dshHome, 'AGENTS.md'), 'utf8'), /新位置人格/);
  assert.equal(existsSync(join(agentsHome, 'AGENTS.md')), true);
});
