/**
 * Slash-command parser tests, plus the README command-table consistency guard.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

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

test('README 命令表与 parse.ts 实际支持的命令完全一致', () => {
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
  const start = readme.indexOf('## 命令');
  assert.ok(start >= 0, 'README 缺少 `## 命令` 段落');
  const rest = readme.slice(start);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const documented = [...section.matchAll(/^\|\s*`\/([a-z]+)/gm)].map((match) => match[1] as string);
  assert.ok(documented.length > 0, 'README 命令表里没有解析到任何命令行');
  assert.deepEqual([...documented].sort(), [...COMMAND_NAMES].sort());
});
