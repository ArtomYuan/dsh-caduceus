/**
 * `/doctor` report: sections, ✓/✗/○/!, counts, text and JSON rendering.
 * All persona paths are mkdtemp; no real ~/.dsh access.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  buildDoctorReport,
  renderDoctorJson,
  renderDoctorText,
  type DoctorInputs,
} from '../src/doctor.js';
import { syncSoul } from '../src/persona/blocks.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-doctor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function personaHome(dir: string): Promise<{ DSH_HOME: string; DSH_AGENTS_HOME: string }> {
  const dshHome = join(dir, 'dsh-home');
  const agentsHome = join(dir, 'agents-home');
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(agentsHome, { recursive: true });
  const env = { DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome };
  writeFileSync(join(dshHome, 'SOUL.md'), '体检人格\n', 'utf8');
  await syncSoul({ env });
  return env;
}

const NOW = Date.parse('2026-11-01T10:00:00Z');

function healthyInputs(env: { DSH_HOME: string; DSH_AGENTS_HOME: string }): DoctorInputs {
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
      connectedSince: NOW - (3 * 60 + 12) * 60 * 1000,
      lastSendAt: NOW - 14 * 60 * 1000,
      lastSendKind: '卡片',
      sendFailures: 0,
    },
    persona: { env },
    session: {
      scopeKey: 'oc_chat\u0000ou_user',
      sessionId: 'feishu-1793463503786',
      preset: 'standard',
      presetMounted: true,
      toolsCount: 37,
      historyLength: 2,
    },
    storage: { mapVersion: 5, mapWritable: true, mapEntries: 5 },
    now: NOW,
  };
}

test('/doctor 全正常：每项 ✓，结论计数正确，文本分段', async (t) => {
  const dir = makeDir(t);
  const env = await personaHome(dir);
  const report = await buildDoctorReport(healthyInputs(env));

  assert.ok(report.items.every((item) => item.mark === 'ok'), JSON.stringify(report.items));
  assert.deepEqual(report.counts, { normal: report.items.length, fail: 0, skip: 0, warn: 0 });

  const text = renderDoctorText(report);
  assert.match(text, /^大肥鱼 · 体检（插件 0\.1\.0，dsh 0\.2\.1-rc\.2，node v22\.23\.2）/);
  for (const section of ['运行时', '飞书', '人格', '会话']) {
    assert.ok(text.includes(`【${section}】`), text);
  }
  assert.match(text, /✓ preset · standard（已挂载）/);
  assert.match(text, /✓ 工具 · 37 个（来自首条请求）/);
  assert.match(text, /✓ 凭证 · cli_aa1…dbc1（机器人：伊冯）/);
  assert.match(text, /✓ 长连接 · ready（已运行 3h12m）/);
  assert.match(text, /✓ 投影 · .*（块存在，与源一致）/);
  assert.match(text, new RegExp(`【结论】${report.items.length} 项正常 · 0 项异常 · 0 项跳过`));
});

test('/doctor 人格不一致：投影 ✗，结论含 1 项异常', async (t) => {
  const dir = makeDir(t);
  const env = await personaHome(dir);
  // Change the SOUL source without syncing: projection must be reported stale.
  writeFileSync(join(env.DSH_HOME, 'SOUL.md'), '改过的人格\n', 'utf8');
  const report = await buildDoctorReport(healthyInputs(env));

  const projection = report.items.find((item) => item.id === 'projection');
  assert.equal(projection?.mark, 'fail');
  assert.equal(report.counts.fail, 1);
  const text = renderDoctorText(report);
  assert.match(text, /✗ 投影 · .*不一致/);
  assert.match(text, /【结论】\d+ 项正常 · 1 项异常 · 0 项跳过/);
});

test('/doctor 某项抛错：该项 ✗，其余项仍正常渲染', async (t) => {
  const dir = makeDir(t);
  const env = await personaHome(dir);
  const inputs = healthyInputs(env);
  const runtime = {
    get preset() {
      return inputs.runtime.preset;
    },
    get presetMounted() {
      return inputs.runtime.presetMounted;
    },
    get toolsCount() {
      return inputs.runtime.toolsCount;
    },
    get sessionTitleService(): boolean {
      throw new Error('title service probe boom');
    },
    get agentsService() {
      return true;
    },
  };
  const report = await buildDoctorReport({ ...inputs, runtime });

  const title = report.items.find((item) => item.id === 'session-title');
  assert.equal(title?.mark, 'fail');
  assert.match(title?.detail ?? '', /title service probe boom/);
  assert.equal(report.items.find((item) => item.id === 'tools')?.mark, 'ok');
  assert.equal(report.counts.fail, 1);
});

test('/doctor --json：结构可解析、含全部分段与项、无 appSecret', async (t) => {
  const dir = makeDir(t);
  const env = await personaHome(dir);
  const report = await buildDoctorReport(healthyInputs(env));
  const parsed = JSON.parse(renderDoctorJson(report)) as {
    title: string;
    counts: { normal: number; fail: number; skip: number; warn: number };
    sections: { title: string; items: { id: string; name: string; mark: string; detail: string }[] }[];
  };
  assert.match(parsed.title, /^大肥鱼 · 体检/);
  assert.deepEqual(
    parsed.sections.map((section) => section.title),
    ['运行时', '飞书', '人格', '会话'],
  );
  const ids = parsed.sections.flatMap((section) => section.items.map((item) => item.id));
  for (const id of ['preset', 'tools', 'session-title', 'agents', 'credentials', 'connection', 'delivery', 'soul', 'projection', 'current', 'storage']) {
    assert.ok(ids.includes(id), `missing doctor item ${id}`);
  }
  assert.equal(parsed.counts.fail, 0);
  const json = renderDoctorJson(report);
  assert.ok(!json.includes('appSecret'));
  assert.ok(!json.includes('secret'));
});

test('/doctor 无数据时用 ○ 且结论统计 skip', async (t) => {
  const dir = makeDir(t);
  const env = await personaHome(dir);
  const report = await buildDoctorReport({
    versions: { plugin: '0.1.0', dsh: 'unknown', node: process.version },
    runtime: { sessionTitleService: false, agentsService: false },
    feishu: {},
    persona: { env },
    session: { scopeKey: 'oc_chat' },
    storage: { mapVersion: 5 },
    now: NOW,
  });
  const marks = new Map(report.items.map((item) => [item.id, item.mark]));
  assert.equal(marks.get('tools'), 'skip');
  assert.equal(marks.get('connection'), 'skip');
  assert.equal(marks.get('session-title'), 'fail'); // service explicitly false
  assert.ok(report.counts.skip >= 2);
  const text = renderDoctorText(report);
  assert.match(text, /○ 工具 · pending/);
  assert.match(text, /【结论】/);
});
