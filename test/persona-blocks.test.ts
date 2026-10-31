/**
 * Persona block tests: pure upsert + file sync.
 *
 * All file operations use `mkdtemp` directories; the real `~/.agents` and
 * `~/.dsh` are never touched.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  SOUL_END_MARKER,
  SOUL_RECOMMENDED_MAX_BYTES,
  SOUL_START_MARKER,
  inspectSoulBlock,
  readSoul,
  renderSoulBlock,
  syncSoul,
  upsertSoulBlock,
} from '../src/persona/blocks.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-persona-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function block(content: string): string {
  return `${SOUL_START_MARKER}\n${content}\n${SOUL_END_MARKER}`;
}

test('inspectSoulBlock: 无标记 → absent；成对 → present；单边/重复 → malformed', () => {
  assert.deepEqual(inspectSoulBlock('# 无块\n'), { status: 'absent' });
  assert.deepEqual(inspectSoulBlock(block('旧')), { status: 'present', content: '\n旧\n' });
  assert.equal(inspectSoulBlock(`${SOUL_START_MARKER}\n没有结尾`).status, 'malformed');
  assert.equal(inspectSoulBlock(`没有开头\n${SOUL_END_MARKER}`).status, 'malformed');
  assert.equal(inspectSoulBlock(`${block('a')}\n${block('b')}`).status, 'malformed');
  const reversed = `${SOUL_END_MARKER}\n${SOUL_START_MARKER}`;
  assert.equal(inspectSoulBlock(reversed).status, 'malformed');
});

test('renderSoulBlock: 规范块；空 body 只有一对标记', () => {
  assert.equal(renderSoulBlock('人格'), `${SOUL_START_MARKER}\n人格\n${SOUL_END_MARKER}`);
  assert.equal(renderSoulBlock(''), `${SOUL_START_MARKER}\n${SOUL_END_MARKER}`);
});

test('upsert: 追加到无块文件，标记外逐字节保留', () => {
  const existing = '# 用户全局指令\n\n保持原样。\n';
  const result = upsertSoulBlock(existing, '你是 Hermes。');
  if (result.status !== 'insert') assert.fail(`unexpected status ${result.status}`);
  assert.ok(result.content.startsWith(existing));
  assert.equal(
    result.content,
    `${existing}${SOUL_START_MARKER}\n你是 Hermes。\n${SOUL_END_MARKER}\n`,
  );
});

test('upsert: 只替换标记之间，前后字节一个不动', () => {
  const prefix = '# 全局\n\n前置内容，不能变。\n\n';
  const suffix = '\n\n后置内容，不能变。\n';
  const existing = `${prefix}${block('旧人格')}${suffix}`;
  const result = upsertSoulBlock(existing, '新人格');
  if (result.status !== 'replace') assert.fail(`unexpected status ${result.status}`);
  assert.ok(result.content.startsWith(prefix));
  assert.ok(result.content.endsWith(suffix));
  assert.equal(
    result.content.slice(prefix.length, result.content.length - suffix.length),
    block('新人格'),
  );
  assert.ok(!result.content.includes('旧人格'));
});

test('upsert: 幂等 —— 内容相同第二次返回 none 且字节不变', () => {
  const first = upsertSoulBlock('', '你是 Hermes。');
  if (first.status !== 'insert') assert.fail(`unexpected status ${first.status}`);
  const second = upsertSoulBlock(first.content, '你是 Hermes。');
  if (second.status !== 'none') assert.fail(`unexpected status ${second.status}`);
  assert.equal(second.content, first.content);
});

test('upsert: 目标文件标记损坏 → malformed-target，不猜内容', () => {
  const result = upsertSoulBlock(`${SOUL_START_MARKER}\n只有开头\n`, '人格');
  assert.equal(result.status, 'malformed-target');
});

test('upsert: SOUL 源自带标记 → invalid-soul，拒绝嵌套', () => {
  assert.equal(upsertSoulBlock('', `${SOUL_START_MARKER}\nx`).status, 'invalid-soul');
  assert.equal(upsertSoulBlock('', `${SOUL_END_MARKER}\nx`).status, 'invalid-soul');
});

test('syncSoul: SOUL 源缺失 → missing，不抛错、不改目标文件', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, '.agents', 'AGENTS.md');
  await mkdir(join(dir, '.agents'), { recursive: true });
  const preamble = '# 用户全局\n\n原样保留。\n';
  await writeFile(agentsFile, preamble, 'utf8');

  const result = await syncSoul({ soulFile, agentsFile });
  assert.equal(result.status, 'missing');
  assert.match(result.reason as string, /soul source unavailable/);
  assert.equal(await readFile(agentsFile, 'utf8'), preamble);
});

test('syncSoul: 源与目标都缺失 → missing，且不创建 AGENTS.md', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, '.agents', 'AGENTS.md');
  const result = await syncSoul({ soulFile, agentsFile });
  assert.equal(result.status, 'missing');
  await assert.rejects(readFile(agentsFile, 'utf8'), /ENOENT/);
});

test('syncSoul: 目标缺失 → created；重复同步 → unchanged（幂等）', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, '.agents', 'AGENTS.md');
  await writeFile(soulFile, '你是 Hermes。\n', 'utf8');

  const created = await syncSoul({ soulFile, agentsFile });
  assert.equal(created.status, 'created');
  const firstContent = await readFile(agentsFile, 'utf8');
  assert.equal(firstContent, `${block('你是 Hermes。')}\n`);

  const again = await syncSoul({ soulFile, agentsFile });
  assert.equal(again.status, 'unchanged');
  assert.equal(await readFile(agentsFile, 'utf8'), firstContent);
});

test('syncSoul: 更新只改标记内，前置内容逐字节保留', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'AGENTS.md');
  const preamble = '# 用户全局\n\n不要动我。\n\n';
  await writeFile(agentsFile, preamble, 'utf8');
  await writeFile(soulFile, '第一版\n', 'utf8');
  assert.equal((await syncSoul({ soulFile, agentsFile })).status, 'updated');
  await writeFile(soulFile, '第二版\n', 'utf8');

  const updated = await syncSoul({ soulFile, agentsFile });
  assert.equal(updated.status, 'updated');
  const content = await readFile(agentsFile, 'utf8');
  assert.ok(content.startsWith(preamble));
  assert.ok(content.endsWith(`\n${SOUL_END_MARKER}\n`));
  assert.ok(content.includes('\n第二版\n'));
  assert.ok(!content.includes('第一版'));
});

test('syncSoul: 目标文件单边标记 → malformed，文件不动', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'AGENTS.md');
  await writeFile(soulFile, '人格\n', 'utf8');
  const broken = `# 全局\n${SOUL_START_MARKER}\n单边标记\n`;
  await writeFile(agentsFile, broken, 'utf8');

  const result = await syncSoul({ soulFile, agentsFile });
  assert.equal(result.status, 'malformed');
  assert.equal(await readFile(agentsFile, 'utf8'), broken);
});

test('syncSoul: SOUL 源含标记 → invalid，目标文件不动', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'AGENTS.md');
  await writeFile(soulFile, `人格\n${SOUL_END_MARKER}\n`, 'utf8');
  await writeFile(agentsFile, '# 全局\n', 'utf8');

  const result = await syncSoul({ soulFile, agentsFile });
  assert.equal(result.status, 'invalid');
  assert.equal(await readFile(agentsFile, 'utf8'), '# 全局\n');
});

test('syncSoul: 超过建议预算只告警，不失败', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'AGENTS.md');
  await writeFile(soulFile, '汉'.repeat(SOUL_RECOMMENDED_MAX_BYTES), 'utf8');

  const result = await syncSoul({ soulFile, agentsFile });
  assert.equal(result.status, 'created');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] as string, /instruction budget/);
});

test('syncSoul: CRLF 归一化为 LF，重复同步仍为 unchanged', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'AGENTS.md');
  await writeFile(soulFile, '\uFEFF第一行\r\n第二行\r\n', 'utf8');
  assert.equal((await syncSoul({ soulFile, agentsFile })).status, 'created');
  const content = await readFile(agentsFile, 'utf8');
  assert.ok(content.includes('\n第一行\n第二行\n'));
  assert.ok(!content.includes('\r'));
  assert.equal((await syncSoul({ soulFile, agentsFile })).status, 'unchanged');
});

test('readSoul: present / absent / missing / malformed 四种状态', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'AGENTS.md');
  await writeFile(soulFile, '你是 Hermes。\n', 'utf8');

  assert.equal((await readSoul({ soulFile, agentsFile })).status, 'missing');

  await writeFile(agentsFile, '# 无块\n', 'utf8');
  assert.equal((await readSoul({ soulFile, agentsFile })).status, 'absent');

  await writeFile(agentsFile, `${block('当前人格')}\n`, 'utf8');
  const present = await readSoul({ soulFile, agentsFile });
  assert.equal(present.status, 'present');
  assert.equal(present.content, '当前人格');

  await writeFile(agentsFile, `${SOUL_START_MARKER}\n单边\n`, 'utf8');
  assert.equal((await readSoul({ soulFile, agentsFile })).status, 'malformed');
});

test('syncSoul 不触碰注入路径之外的任何文件', async (t) => {
  const dir = makeDir(t);
  const soulFile = join(dir, 'SOUL.md');
  const agentsFile = join(dir, 'nested', 'AGENTS.md');
  const other = join(dir, 'other.txt');
  await writeFile(soulFile, '人格\n', 'utf8');
  writeFileSync(other, '不要动', 'utf8');

  await syncSoul({ soulFile, agentsFile });
  assert.equal(readFileSync(other, 'utf8'), '不要动');
  assert.ok((await readFile(agentsFile, 'utf8')).includes(SOUL_END_MARKER));
});
