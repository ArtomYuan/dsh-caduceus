/**
 * Slash-command parser tests, plus the README command-table consistency guard.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { planSlashLine, isWebOnlyCommand, WEB_ONLY_DENYLIST } from '../src/commands/dispatch.js';
import { COMMAND_NAMES, COMMAND_SPECS, helpText, parseCommand } from '../src/commands/parse.js';

test('七条自有命令全部识别', () => {
  assert.deepEqual(parseCommand('/new'), { kind: 'new' });
  assert.deepEqual(parseCommand('/sessions'), { kind: 'sessions' });
  assert.deepEqual(parseCommand('/rename 新标题'), { kind: 'rename', title: '新标题' });
  assert.deepEqual(parseCommand('/resume'), { kind: 'resume' });
  assert.deepEqual(parseCommand('/resume feishu-42'), { kind: 'resume', sessionId: 'feishu-42' });
  assert.deepEqual(parseCommand('/stop'), { kind: 'stop' });
  assert.deepEqual(parseCommand('/persona'), { kind: 'persona', action: 'show' });
  assert.deepEqual(parseCommand('/persona show'), { kind: 'persona', action: 'show' });
  assert.deepEqual(parseCommand('/persona sync'), { kind: 'persona', action: 'sync' });
  assert.deepEqual(parseCommand('/help'), { kind: 'help' });
});

test('/rename 保留标题内的空格与中英文', () => {
  assert.deepEqual(parseCommand('/rename 带 空格 的标题'), { kind: 'rename', title: '带 空格 的标题' });
  assert.deepEqual(parseCommand('  /rename   两个 空格  '), { kind: 'rename', title: '两个 空格' });
});

test('命令名大小写不敏感，参数保留原样', () => {
  assert.deepEqual(parseCommand('/NEW'), { kind: 'new' });
  assert.deepEqual(parseCommand('/PERSONA SYNC'), { kind: 'persona', action: 'sync' });
  assert.deepEqual(parseCommand('/Resume feishu-9'), { kind: 'resume', sessionId: 'feishu-9' });
});

test('参数非法 → usage（不误伤透传）', () => {
  assert.equal(parseCommand('/rename').kind, 'usage');
  assert.equal(parseCommand('/rename    ').kind, 'usage');
  assert.equal(parseCommand('/persona 未知').kind, 'usage');
  assert.equal(parseCommand('/resume a b').kind, 'usage');
  assert.equal(parseCommand('/new 多余参数').kind, 'usage');
  assert.equal(parseCommand('/sessions 多余参数').kind, 'usage');
  assert.equal(parseCommand('/stop 多余参数').kind, 'usage');
});

test('未知 /命令 → passthrough，raw 与输入逐字节一致', () => {
  assert.deepEqual(parseCommand('/compact'), { kind: 'passthrough', raw: '/compact' });
  assert.deepEqual(parseCommand('/model deepseek-flash'), {
    kind: 'passthrough',
    raw: '/model deepseek-flash',
  });
  assert.deepEqual(parseCommand('  /unknown  x  '), { kind: 'passthrough', raw: '  /unknown  x  ' });
  assert.deepEqual(parseCommand('/'), { kind: 'passthrough', raw: '/' });
});

test('普通消息（含多行、首尾空白）→ passthrough，raw 不变', () => {
  assert.deepEqual(parseCommand('你好'), { kind: 'passthrough', raw: '你好' });
  assert.deepEqual(parseCommand('  两行\n消息  '), { kind: 'passthrough', raw: '  两行\n消息  ' });
});

test('COMMAND_SPECS 与 COMMAND_NAMES 一致，helpText 覆盖全部命令', () => {
  assert.deepEqual(
    COMMAND_SPECS.map((spec) => spec.name),
    [...COMMAND_NAMES],
  );
  const help = helpText();
  for (const name of COMMAND_NAMES) assert.match(help, new RegExp(`/${name}\\b`));
});

test('README/README.zh.md 命令表与 parse.ts 实际支持的命令完全一致', () => {
  for (const file of ['README.md', 'README.zh.md']) {
    const readme = readFileSync(join(process.cwd(), file), 'utf8');
    const heading = /^## (?:命令|Commands).*$/m.exec(readme);
    assert.ok(heading !== null, `${file} 缺少命令表段落（## Commands / ## 命令）`);
    const start = heading.index;
    const rest = readme.slice(start);
    const nextHeading = rest.indexOf('\n## ', 1);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const documented = [...section.matchAll(/^\|\s*`\/([a-z]+)/gm)].map(
      (match) => match[1] as string,
    );
    assert.ok(documented.length > 0, `${file} 命令表里没有解析到任何命令行`);
    assert.deepEqual([...documented].sort(), [...COMMAND_NAMES].sort(), file);
  }
});

test('/status 是自有命令，参数非法返回 usage', () => {
  assert.deepEqual(parseCommand('/status'), { kind: 'status' });
  assert.deepEqual(parseCommand('/STATUS'), { kind: 'status' });
  assert.equal(parseCommand('/status 多余').kind, 'usage');
  assert.ok(COMMAND_NAMES.includes('status'));
});

test('dispatch：自有命令 owned、/export 拒绝、其余透传原文', () => {
  assert.deepEqual(planSlashLine('/status'), {
    kind: 'owned',
    command: { kind: 'status' },
  });
  assert.deepEqual(planSlashLine('/export'), {
    kind: 'denied',
    name: 'export',
    line: '/export',
  });
  assert.deepEqual(planSlashLine('/compact'), {
    kind: 'forward',
    name: 'compact',
    line: '/compact',
  });
  assert.deepEqual(planSlashLine('  /model deepseek-flash  '), {
    kind: 'forward',
    name: 'model',
    line: '  /model deepseek-flash  ',
  });
  assert.equal(planSlashLine('/').kind, 'forward');
});

test('denylist 至少包含 /export，且大小写不敏感', () => {
  assert.ok(WEB_ONLY_DENYLIST.includes('export'));
  assert.equal(isWebOnlyCommand('export'), true);
  assert.equal(isWebOnlyCommand('EXPORT'), true);
  assert.equal(isWebOnlyCommand('compact'), false);
});

test('/doctor 支持 --json，其他参数返回 usage', () => {
  assert.deepEqual(parseCommand('/doctor'), { kind: 'doctor' });
  assert.deepEqual(parseCommand('/doctor --json'), { kind: 'doctor', json: true });
  assert.equal(parseCommand('/doctor now').kind, 'usage');
  assert.ok(COMMAND_NAMES.includes('doctor'));
});

test('/selfcheck 是无参自有命令', () => {
  assert.deepEqual(parseCommand('/selfcheck'), { kind: 'selfcheck' });
  assert.equal(parseCommand('/selfcheck now').kind, 'usage');
  assert.ok(COMMAND_NAMES.includes('selfcheck'));
});

test('/adopt 是自有命令，参数非法返回 usage', () => {
  assert.deepEqual(parseCommand('/adopt feishu-1793463503786'), {
    kind: 'adopt',
    sessionId: 'feishu-1793463503786',
  });
  assert.equal(parseCommand('/adopt').kind, 'usage');
  assert.equal(parseCommand('/adopt a b').kind, 'usage');
  assert.ok(COMMAND_NAMES.includes('adopt'));
});

test('/sessions 支持 --all；带其他参数仍返回 usage', () => {
  assert.deepEqual(parseCommand('/sessions'), { kind: 'sessions' });
  assert.deepEqual(parseCommand('/sessions --all'), { kind: 'sessions', all: true });
  assert.deepEqual(parseCommand('/SESSIONS --ALL'), { kind: 'sessions', all: true });
  assert.equal(parseCommand('/sessions --other').kind, 'usage');
});
