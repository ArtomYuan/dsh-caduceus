/**
 * Self-check: stage A services/instructions/persona, stage B applied preset and
 * tool count. All file paths live in mkdtemp; no real ~/.dsh access.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { syncSoul } from '../src/persona/blocks.js';
import { SelfChecker } from '../src/selfcheck.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-selfcheck-'));
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

/** Write a fresh SOUL + synced AGENTS block; returns env/paths. */
async function syncedHome(dir: string): Promise<{
  env: { DSH_HOME: string; DSH_AGENTS_HOME: string };
  target: string;
}> {
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '自检人格\n', 'utf8');
  await syncSoul({ env });
  return { env, target: join(dshHome, 'AGENTS.md') };
}

function recordingLogger(): {
  logger: { info(message: string): void; warn(message: string): void; error(): void; debug(): void };
  lines: string[];
  warnings: string[];
} {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    logger: {
      info: (message: string) => lines.push(message),
      warn: (message: string) => warnings.push(message),
      error: () => {},
      debug: () => {},
    },
    lines,
    warnings,
  };
}

const presetsOk = {
  async mount(_ctx: unknown, id?: string) {
    return { id };
  },
  composedPreset() {
    return 'standard';
  },
};

test('阶段 A 全过 + 阶段 B 全过：只打一行 selfcheck: ok', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, lines, warnings } = recordingLogger();
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });

  const a = await checker.runStageA();
  assert.deepEqual(
    a.items.map((entry) => `${entry.id}:${entry.status}`),
    ['preset:service:ok', 'instructions:block:ok', 'persona:fresh:ok', 'tools:service:ok'],
  );
  assert.deepEqual(lines, [], 'stage A alone defers the ok line');
  assert.equal(checker.statusLine(), '自检 …', 'stage B has not run yet');

  const b = await checker.runStageB({ sessionId: 's1' });
  assert.equal(b.items.find((entry) => entry.id === 'tools:count')?.status, 'skip');
  const counted = await checker.checkTools(3);
  assert.deepEqual(
    counted.items.map((entry) => `${entry.id}:${entry.status}`),
    ['preset:applied:ok', 'tools:count:ok'],
  );
  assert.equal(checker.statusLine(), '自检 ✓');
  assert.deepEqual(lines, [
    `selfcheck: ok preset=standard tools=3 persona=${Buffer.byteLength('自检人格', 'utf8')}B`,
  ]);
  assert.deepEqual(warnings, []);
});

test('阶段 A：指令块缺失 / 多对 / 人格不一致 → 对应 fail，且不抛错', async (t) => {
  const dir = makeDir(t);
  const { dshHome, agentsHome } = homes(dir);
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '人格\n', 'utf8');

  const missing = new SelfChecker({ env, getAgentPresets: () => presetsOk, getTools: () => ({}) });
  const aMissing = await missing.runStageA();
  assert.equal(
    aMissing.items.find((entry) => entry.id === 'instructions:block')?.status,
    'fail',
  );
  assert.equal(aMissing.items.find((entry) => entry.id === 'persona:fresh')?.status, 'skip');

  writeFileSync(
    join(dshHome, 'AGENTS.md'),
    '<!-- dsh-caduceus:soul:start -->\nA\n<!-- dsh-caduceus:soul:end -->\n<!-- dsh-caduceus:soul:start -->\nB\n<!-- dsh-caduceus:soul:end -->\n',
    'utf8',
  );
  const multiple = await missing.runStageA();
  assert.equal(
    multiple.items.find((entry) => entry.id === 'instructions:block')?.status,
    'fail',
  );

  writeFileSync(join(dshHome, 'AGENTS.md'), '<!-- dsh-caduceus:soul:start -->\n旧\n<!-- dsh-caduceus:soul:end -->\n', 'utf8');
  const stale = await missing.runStageA();
  assert.equal(stale.items.find((entry) => entry.id === 'persona:fresh')?.status, 'fail');
  assert.match(
    stale.items.find((entry) => entry.id === 'persona:fresh')?.detail ?? '',
    /不一致/,
  );
});

test('阶段 A：服务尚未注册 → skip/degraded，不得含 fail，/status 显示 ○', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, lines } = recordingLogger();
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => undefined,
    getTools: () => undefined,
  });
  const report = await checker.runStageA();
  assert.equal(report.status, 'degraded');
  assert.ok(!report.items.some((entry) => entry.status === 'fail'), 'services must not be fake failures');
  const status = new Map(report.items.map((entry) => [entry.id, entry]));
  assert.equal(status.get('preset:service')?.status, 'skip');
  assert.match(status.get('preset:service')?.detail ?? '', /尚未注册/);
  assert.equal(status.get('tools:service')?.status, 'skip');
  assert.equal(status.get('instructions:block')?.status, 'ok');
  assert.equal(status.get('persona:fresh')?.status, 'ok');
  assert.equal(checker.statusLine(), '自检 ○（待首会话验证）');
  assert.deepEqual(lines, [
    'selfcheck: ok (skipped: preset:service, tools:service; deferred to first session)',
  ]);
});

test('阶段 A 服务 skip 后首会话验证成功：A 服务项刷新，/status 转 ✓', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, warnings } = recordingLogger();
  let available = false;
  const presets = {
    async mount() {},
    composedPreset: () => (available ? 'standard' : undefined),
  };
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => (available ? presets : undefined),
    getTools: () => (available ? {} : undefined),
  });
  await checker.runStageA();
  assert.equal(checker.statusLine(), '自检 ○（待首会话验证）');

  available = true;
  await checker.runStageB({});
  const b = await checker.checkTools(4);
  assert.equal(b.status, 'ok');
  assert.equal(checker.statusLine(), '自检 ✓');
  // No failures at any point: the startup skip was not a fake alarm.
  assert.deepEqual(warnings, []);
});

test('阶段 B：composedPreset 为空 → preset:applied fail，/status 显示 ✗', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const checker = new SelfChecker({
    env,
    getAgentPresets: () => ({ async mount() {}, composedPreset: () => undefined }),
    getTools: () => ({}),
  });
  await checker.runStageA();
  const report = await checker.runStageB({});
  assert.equal(report.items.find((entry) => entry.id === 'preset:applied')?.status, 'fail');
  assert.match(checker.statusLine(), /^自检 ✗ preset:applied/);
});

test('阶段 B：工具数 0 → tools:count fail；连续两次同 fail 只 warn 一次', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, warnings } = recordingLogger();
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });
  await checker.runStageA();
  await checker.runStageB({});
  await checker.checkTools(0);
  await checker.checkTools(0);
  assert.equal(checker.statusLine(), '自检 ✗ tools:count');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /^selfcheck: FAIL tools:count\(fail\)/);
});

test('阶段 B：全 ok 连续两次只打一次 ok 日志；fail→ok 时再打', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, lines } = recordingLogger();
  let composed: string | undefined;
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => ({ async mount() {}, composedPreset: () => composed }),
    getTools: () => ({}),
  });
  await checker.runStageA();
  composed = 'standard';
  await checker.runStageB({});
  await checker.checkTools(2);
  await checker.checkTools(2);
  assert.equal(lines.filter((line) => line.startsWith('selfcheck: ok')).length, 1);
});

test('阶段 B：API 不可用（toolCount 未接线）→ skip，不假报 fail', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const checker = new SelfChecker({
    env,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });
  const report = await checker.runStageB({});
  assert.equal(report.items.find((entry) => entry.id === 'tools:count')?.status, 'skip');
  assert.equal(checker.statusLine(), '自检 ○（待首会话验证）');
});

test('未收到 request/header → pending，不 fail', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, warnings } = recordingLogger();
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });
  await checker.runStageA();
  const b = await checker.runStageB({});
  assert.equal(b.items.find((entry) => entry.id === 'tools:count')?.status, 'skip');
  assert.ok(!checker.report().some((entry) => entry.status === 'fail'));
  assert.doesNotMatch(checker.statusLine(), /✗/);
  assert.deepEqual(warnings, []);
});

test('首条 request/header 带 37 个工具 → tools=37，状态 ok', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, lines } = recordingLogger();
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });
  await checker.runStageA();
  await checker.runStageB({});

  const before = checker.report().find((entry) => entry.id === 'tools:count');
  assert.equal(before?.status, 'skip');
  assert.equal(lines.filter((line) => line.startsWith('selfcheck: ok')).length, 0);

  const counted = await checker.checkTools(37);
  assert.equal(counted.items.find((entry) => entry.id === 'tools:count')?.status, 'ok');
  assert.match(
    checker.report().find((entry) => entry.id === 'tools:count')?.detail ?? '',
    /tools=37/,
  );
  assert.equal(checker.statusLine(), '自检 ✓');
  assert.ok(
    lines.some((line) => /selfcheck: ok preset=standard tools=37/.test(line)),
    lines.join(' | '),
  );
});

test('request/header.tools 为空数组 → tools:count fail', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const { logger, warnings } = recordingLogger();
  const checker = new SelfChecker({
    env,
    logger,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });
  await checker.runStageA();
  await checker.runStageB({});
  const report = await checker.checkTools(0);

  const toolsItem = report.items.find((entry) => entry.id === 'tools:count');
  assert.equal(toolsItem?.status, 'fail');
  assert.match(toolsItem?.detail ?? '', /request\/header\.tools 为空/);
  assert.equal(checker.statusLine(), '自检 ✗ tools:count');
  const failLine = warnings.find((line) => line.startsWith('selfcheck: FAIL'));
  assert.ok(failLine !== undefined);
  assert.match(failLine, /tools:count\(fail\): request\/header\.tools 为空/);
});

test('不再依赖 tools 服务计数：SelfCheckOptions 无 toolCount 依赖也能出结果', async (t) => {
  const dir = makeDir(t);
  const { env } = await syncedHome(dir);
  const checker = new SelfChecker({
    env,
    getAgentPresets: () => presetsOk,
    getTools: () => ({}),
  });
  const options = checker as unknown as { toolCount?: unknown };
  assert.equal(options.toolCount, undefined);
  await checker.runStageA();
  await checker.runStageB({});
  await checker.checkTools(37);
  assert.equal(checker.statusLine(), '自检 ✓');
});
