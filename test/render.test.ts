/**
 * Render tests: card invariants (update_multi, ≤30 KB, UTF-8 truncation) and
 * the CardStream throttle under a fake clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_BYTE_LIMIT,
  cardByteSize,
  collapsedProcessCard,
  finalCard,
  finalCardPlainText,
  markdownCard,
  progressCard,
  tailText,
} from '../src/render/cards.js';
import { CardStream, type CardChannel } from '../src/render/stream.js';
import type { FeishuCard } from '../src/transport/types.js';
import { FakeClock, tick } from './support/fakes.js';

class RecordingChannel implements CardChannel {
  readonly created: FeishuCard[] = [];
  readonly updates: { readonly messageId: string; readonly card: FeishuCard }[] = [];
  private seq = 0;

  async create(card: FeishuCard): Promise<{ messageId: string }> {
    this.created.push(card);
    this.seq += 1;
    return { messageId: `card-${this.seq}` };
  }

  async update(messageId: string, card: FeishuCard): Promise<void> {
    this.updates.push({ messageId, card });
  }
}

function textCard(text: string): FeishuCard {
  return markdownCard('测试', text);
}

test('卡片必须带 config.update_multi=true', () => {
  for (const card of [
    textCard('x'),
    progressCard({ title: '过程', stateLabel: '运行中', steps: 1, tools: 0 }),
  ]) {
    assert.equal(card.config.update_multi, true);
  }
});

test('过程卡运行中承载正文尾部 + 状态行，且 ≤30KB', () => {
  const body = '第一句完整回答。第二句完整回答。';
  const card = progressCard({
    title: '过程',
    stateLabel: '运行中',
    steps: 2,
    tools: 1,
    sessionTitle: '会话标题',
    recentEvent: 'tool/call',
    tail: body,
    startedAt: 0,
    now: 5_000,
  });
  const serialized = JSON.stringify(card);
  assert.match(serialized, /第一句完整回答/);
  assert.match(serialized, /会话：会话标题/);
  // 状态行只留状态与计时；步数/工具数改由步骤段与用量段承载。
  assert.match(serialized, /\*\*运行中\*\* · 已运行 5s/);
  assert.ok(!serialized.includes('步数 2'), 'step count must not be crammed on the status line');
  assert.ok(serialized.includes('"tag":"hr"'), 'blocks are separated by a divider');
  assert.match(serialized, /最近：tool\/call/);
  assert.match(serialized, /结束后会置灰收起，正文另发/);

  const long = progressCard({
    title: '过程',
    stateLabel: '运行中',
    steps: 2,
    tools: 1,
    tail: '汉😀'.repeat(6_000),
  });
  assert.ok(cardByteSize(long) <= CARD_BYTE_LIMIT, `card is ${cardByteSize(long)} bytes`);
  assert.match(JSON.stringify(long), /已省略 \d+ 字符/);
  assert.ok(!JSON.stringify(long).includes('\uFFFD'));
});

test('终态卡：完整正文入卡；超 30KB 保留尾部并写「…已省略 N 字符」', () => {
  const input = {
    title: '飞书会话 · 过程',
    stateLabel: '完成',
    steps: 3,
    tools: 2,
    startedAt: 0,
    endedAt: 5_000,
    sessionTitle: '会话标题',
    body: '完整正文第一段。完整正文第二段。',
  };
  const card = finalCard(input);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /完整正文第一段/);
  assert.match(serialized, /完整正文第二段/);
  assert.match(serialized, /会话：会话标题/);
  assert.match(serialized, /完成/);
  assert.ok(!serialized.includes('…已省略'));
  assert.equal(finalCardPlainText(input), '会话：会话标题 · 完成 · 步数 3 · 工具 2 · 已运行 5s\n\n完整正文第一段。完整正文第二段。');

  const long = finalCard({ ...input, body: `开头标记${'汉'.repeat(20_000)}结尾标记` });
  assert.ok(cardByteSize(long) <= CARD_BYTE_LIMIT, `card is ${cardByteSize(long)} bytes`);
  const longText = JSON.stringify(long);
  assert.match(longText, /…已省略 \d+ 字符/);
  assert.ok(longText.includes('结尾标记'));
  assert.ok(!longText.includes('开头标记'));
  assert.ok(!longText.includes('\uFFFD'));

  const tinyInput = { ...input, body: '汉😀'.repeat(3) };
  const tiny = finalCard(tinyInput);
  assert.ok(cardByteSize(tiny) <= CARD_BYTE_LIMIT);
  assert.match(JSON.stringify(tiny), /汉😀/);
});

test('tailText: 短文本原样、长文本 UTF-8 安全截尾', () => {
  assert.equal(tailText('短内容'), '短内容');
  const long = '汉'.repeat(5000);
  const cut = tailText(long, 100);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 100 + Buffer.byteLength('（已省略 4967 字符）\n\n', 'utf8'));
  assert.ok(!cut.includes('\uFFFD'));
  assert.match(cut, /已省略 \d+ 字符/);
});

test('CardStream: 首次立即建卡，窗口内合并，400ms 后只 patch 最新一次', async () => {
  const clock = new FakeClock();
  const channel = new RecordingChannel();
  const stream = new CardStream(channel, { throttleMs: 400, clock });

  await stream.set(textCard('A'));
  assert.equal(channel.created.length, 1);
  assert.equal(stream.messageId, 'card-1');
  assert.equal(channel.updates.length, 0);

  await stream.set(textCard('B'));
  await stream.set(textCard('C'));
  assert.equal(channel.updates.length, 0, 'must not patch inside the throttle window');

  clock.advance(400);
  await tick();
  await stream.flush();
  assert.equal(channel.updates.length, 1, 'exactly one trailing patch');
  assert.match(JSON.stringify(channel.updates[0]?.card), /C/);
  assert.equal(channel.updates[0]?.messageId, 'card-1');
});

test('CardStream: 内容未变化不更新', async () => {
  const clock = new FakeClock();
  const channel = new RecordingChannel();
  const stream = new CardStream(channel, { throttleMs: 400, clock });

  await stream.set(textCard('same'));
  await stream.set(textCard('same'));
  clock.advance(500);
  await stream.flush();
  assert.equal(channel.created.length, 1);
  assert.equal(channel.updates.length, 0);
});

test('CardStream: 窗口外立即更新；窗口内新内容仍合并', async () => {
  const clock = new FakeClock();
  const channel = new RecordingChannel();
  const stream = new CardStream(channel, { throttleMs: 400, clock });

  await stream.set(textCard('A'));
  clock.advance(500);
  await stream.set(textCard('B'));
  assert.equal(channel.updates.length, 1, 'elapsed window updates immediately');

  await stream.set(textCard('C'));
  assert.equal(channel.updates.length, 1, 'new content inside the window is pending');
  clock.advance(400);
  await tick();
  await stream.flush();
  assert.equal(channel.updates.length, 2);
  assert.match(JSON.stringify(channel.updates[1]?.card), /C/);
});

test('CardStream: dispose 后丢弃 pending，不再更新', async () => {
  const clock = new FakeClock();
  const channel = new RecordingChannel();
  const stream = new CardStream(channel, { throttleMs: 400, clock });

  await stream.set(textCard('A'));
  await stream.set(textCard('B'));
  stream.dispose();
  clock.advance(1000);
  await tick();
  assert.equal(channel.updates.length, 0);
  assert.equal(clock.pendingTimers, 0);
});

test('CardStream: 默认卡通道错误只上报不炸事件循环', async () => {
  const clock = new FakeClock();
  const errors: unknown[] = [];
  const failing: CardChannel = {
    async create() {
      throw new Error('send failed');
    },
    async update() {
      throw new Error('patch failed');
    },
  };
  const stream = new CardStream(failing, {
    throttleMs: 400,
    clock,
    onError: (error) => errors.push(error),
  });
  await stream.set(textCard('A'));
  await stream.set(textCard('B'));
  clock.advance(400);
  await tick();
  await stream.flush();
  assert.ok(errors.length >= 1);
});

test('收起卡：去按钮、去运行脚注、换灰底并附收起说明', () => {
  const live = progressCard({
    title: '过程',
    stateLabel: '运行中',
    steps: 1,
    tools: 1,
    stepLines: ['✓ bash · 0.5s'],
    stopButton: true,
  });
  const grey = collapsedProcessCard(live, '已收起 · 1 步');
  assert.equal(grey.header?.template, 'grey');
  const serialized = JSON.stringify(grey);
  assert.ok(!serialized.includes('停止'), 'the stop button must be gone');
  assert.ok(!serialized.includes('结束后会置灰收起'), 'the running footnote must be gone');
  assert.match(serialized, /已收起 · 1 步/);
});
