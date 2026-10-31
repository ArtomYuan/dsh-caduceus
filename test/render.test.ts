/**
 * Render tests: card invariants (update_multi, ≤30 KB, UTF-8 truncation) and
 * the CardStream throttle under a fake clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_BYTE_LIMIT,
  cardByteSize,
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

test('过程卡不承载正文：只含状态行/最近事件/收尾提示，且 ≤30KB', () => {
  const body = '第一句完整回答。第二句完整回答。';
  const card = progressCard({
    title: '过程',
    stateLabel: '运行中',
    steps: 2,
    tools: 1,
    sessionTitle: '会话标题',
    recentEvent: 'tool/call',
    startedAt: 0,
    now: 5_000,
  });
  const serialized = JSON.stringify(card);
  for (const sentence of ['第一句完整回答', '第二句完整回答', body]) {
    assert.ok(!serialized.includes(sentence), 'process card must never carry the answer body');
  }
  assert.match(serialized, /会话：会话标题/);
  assert.match(serialized, /步数 2/);
  assert.match(serialized, /工具 1/);
  assert.match(serialized, /已运行 5s/);
  assert.match(serialized, /最近：tool\/call/);
  assert.match(serialized, /收尾会另发一条终稿/);

  const long = progressCard({
    title: '过程',
    stateLabel: '运行中',
    steps: 2,
    tools: 1,
    sessionTitle: '长'.repeat(5_000),
    recentEvent: 'x'.repeat(5_000),
  });
  assert.ok(cardByteSize(long) <= CARD_BYTE_LIMIT, `card is ${cardByteSize(long)} bytes`);
  assert.ok(!JSON.stringify(long).includes('\uFFFD'));
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
