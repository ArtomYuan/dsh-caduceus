/**
 * Card truncation tests: UTF-8 safety, byte budgets, omitted-character count.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_TAIL_BYTES,
  truncateCardContent,
} from '../src/render/truncate.js';

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

test('短于预算 → 原样返回，truncated=false', () => {
  const input = '你好，世界 🌍';
  const result = truncateCardContent(input);
  assert.deepEqual(result, {
    text: input,
    truncated: false,
    keptBytes: bytes(input),
    omittedBytes: 0,
    omittedChars: 0,
  });
  assert.equal(truncateCardContent('').text, '');
});

test('默认预算为约 8KB 尾部', () => {
  const input = 'a'.repeat(CARD_TAIL_BYTES + 100);
  const result = truncateCardContent(input);
  assert.equal(result.truncated, true);
  assert.equal(result.keptBytes, CARD_TAIL_BYTES);
  assert.equal(result.omittedChars, 100);
  assert.ok(result.text.endsWith('a'.repeat(CARD_TAIL_BYTES)));
  assert.ok(result.text.includes('已省略 100 字符'));
});

test('ASCII：省略字符数、保留字节数、尾部内容都正确', () => {
  const input = '0123456789'.repeat(10); // 100 bytes
  const result = truncateCardContent(input, { maxBytes: 40 });
  assert.equal(result.truncated, true);
  assert.equal(result.keptBytes, 40);
  assert.equal(result.omittedChars, 60);
  assert.equal(result.omittedBytes, 60);
  assert.ok(result.text.endsWith('0123456789'.repeat(4)));
  assert.ok(result.text.includes('已省略 60 字符'));
});

test('中文：切在码点边界，不产生 U+FFFD，可无损往返', () => {
  const input = '汉'.repeat(100); // 300 bytes
  const result = truncateCardContent(input, { maxBytes: 100 });
  assert.equal(result.truncated, true);
  assert.ok(result.keptBytes <= 100);
  assert.equal(result.keptBytes, 99); // 33 × 3 bytes
  assert.equal(result.omittedChars, 67);
  assert.ok(!result.text.includes('\uFFFD'));
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text);
  const tailOnly = truncateCardContent(input, { maxBytes: 100, note: () => '' });
  assert.ok(input.endsWith(tailOnly.text));
});

test('4 字节 emoji：只保留完整码点，绝不切断代理对', () => {
  const input = '😀'.repeat(50); // 200 bytes
  const result = truncateCardContent(input, { maxBytes: 7 });
  assert.equal(result.keptBytes, 4);
  assert.equal(result.omittedChars, 49);
  assert.ok(!result.text.includes('\uFFFD'));
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text);
  const tailOnly = truncateCardContent(input, { maxBytes: 7, note: () => '' });
  assert.equal(tailOnly.text, '😀');
});

test('混合中英文与 emoji：尾部是原文的合法后缀', () => {
  const input = `开头${'😀汉a'.repeat(200)}结尾`;
  const result = truncateCardContent(input, { maxBytes: 50, note: () => '' });
  assert.ok(result.keptBytes <= 50);
  assert.ok(input.endsWith(result.text));
  assert.equal(Buffer.from(result.text, 'utf8').toString('utf8'), result.text);
});

test('省略提示由调用方注入时按字符数调用', () => {
  let seen = 0;
  const result = truncateCardContent('x'.repeat(10), {
    maxBytes: 3,
    note: (omittedChars) => {
      seen = omittedChars;
      return '';
    },
  });
  assert.equal(seen, 7);
  assert.equal(result.text, 'xxx');
  assert.equal(result.omittedChars, 7);
});

test('非法预算抛 RangeError', () => {
  assert.throws(() => truncateCardContent('x', { maxBytes: 0 }), RangeError);
  assert.throws(() => truncateCardContent('x', { maxBytes: -1 }), RangeError);
  assert.throws(() => truncateCardContent('x', { maxBytes: 1.5 }), RangeError);
  assert.throws(() => truncateCardContent('x', { maxBytes: Number.NaN }), RangeError);
});
