/**
 * Transport tests: inbound normalization (thread identity) and the reliable
 * transport policy (thread fallback + uuid idempotency + update_multi).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMessageEvent, type RawMessageEventLike } from '../src/transport/normalize.js';
import { ReliableTransport } from '../src/transport/reliable.js';
import { FeishuApiError, type FeishuCard } from '../src/transport/types.js';
import { FakeFeishuApi } from './support/fakes.js';

function raw(
  message: Partial<RawMessageEventLike['message']> = {},
): RawMessageEventLike {
  return {
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      create_time: '1700000000000',
      ...message,
    },
  };
}

function reliable(api: FakeFeishuApi): ReliableTransport {
  let seq = 0;
  return new ReliableTransport(api, {
    uuidFactory: () => {
      seq += 1;
      return `uuid-${seq}`;
    },
  });
}

const card: FeishuCard = {
  config: { update_multi: true, wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 't' } },
  elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'body' } }],
};

test('normalize: thread_id 优先于 root_id（话题标识必须保留）', () => {
  const message = normalizeMessageEvent(raw({ thread_id: 'omt_thread', root_id: 'om_root' }));
  assert.ok(message !== undefined);
  assert.equal(message.threadId, 'omt_thread');
  assert.equal(message.rootId, 'om_root');
});

test('normalize: 只有 root_id 时回落到 root_id', () => {
  const message = normalizeMessageEvent(raw({ root_id: 'om_root' }));
  assert.ok(message !== undefined);
  assert.equal(message.threadId, 'om_root');
});

test('normalize: 无话题字段时 threadId 为 undefined', () => {
  const message = normalizeMessageEvent(raw());
  assert.ok(message !== undefined);
  assert.equal(message.threadId, undefined);
  assert.equal(message.rootId, undefined);
});

test('normalize: 文本、chat 类型、发送者与时间归一化', () => {
  const message = normalizeMessageEvent(
    raw({
      content: JSON.stringify({ text: '<at user_id="ou_bot">@机器人</at> 你好\r\n第二行' }),
      chat_type: 'p2p',
    }),
  );
  assert.ok(message !== undefined);
  assert.equal(message.chatType, 'p2p');
  assert.equal(message.senderOpenId, 'ou_sender');
  assert.equal(message.text, '你好\n第二行');
  assert.equal(message.createdAt, 1_700_000_000_000);
});

test('normalize: 非 text 类型与坏 JSON 返回 undefined', () => {
  assert.equal(normalizeMessageEvent(raw({ message_type: 'image' })), undefined);
  assert.equal(normalizeMessageEvent(raw({ content: '{oops' })), undefined);
  assert.equal(
    normalizeMessageEvent(raw({ content: JSON.stringify({ text: '   ' }) })),
    undefined,
  );
});

test('reliable: 话题回复带 reply_in_thread 与 uuid', async () => {
  const api = new FakeFeishuApi();
  const transport = reliable(api);
  const sent = await transport.reply('oc_chat', 'om_1', { kind: 'text', text: 'hi' }, {
    threadId: 'omt_t',
  });
  assert.equal(sent.messageId, 'api-reply-1');
  assert.equal(api.replied.length, 1);
  assert.equal(api.replied[0]?.replyInThread, true);
  assert.equal(api.replied[0]?.msgType, 'text');
  assert.equal(api.replied[0]?.uuid, 'uuid-1');
  assert.equal(api.created.length, 0);
});

test('reliable: 无话题时 reply 不带 reply_in_thread', async () => {
  const api = new FakeFeishuApi();
  const transport = reliable(api);
  await transport.reply('oc_chat', 'om_1', { kind: 'text', text: 'hi' });
  assert.equal(api.replied[0]?.replyInThread, false);
});

for (const code of [230071, 230072, 230019]) {
  test(`reliable: 话题回复失败码 ${code} → 降级 chat_id 直发且复用同一 uuid`, async () => {
    const api = new FakeFeishuApi();
    api.failReplyCodes.push(code);
    const transport = reliable(api);
    const sent = await transport.reply(
      'oc_chat',
      'om_1',
      { kind: 'text', text: '降级内容' },
      { threadId: 'omt_t' },
    );
    assert.equal(sent.messageId, 'api-created-1');
    assert.equal(api.replied.length, 1);
    assert.equal(api.created.length, 1);
    assert.equal(api.created[0]?.chatId, 'oc_chat');
    assert.equal(api.created[0]?.content, JSON.stringify({ text: '降级内容' }));
    // Same idempotency key on both attempts: one logical message at most once.
    assert.equal(api.created[0]?.uuid, api.replied[0]?.uuid);
  });
}

test('reliable: 非降级错误照常抛出，不静默吞掉', async () => {
  const api = new FakeFeishuApi();
  api.failReplyCodes.push(999999);
  const transport = reliable(api);
  await assert.rejects(
    transport.reply('oc_chat', 'om_1', { kind: 'text', text: 'x' }, { threadId: 'omt_t' }),
    (error: unknown) => error instanceof FeishuApiError && error.code === 999999,
  );
  assert.equal(api.created.length, 0);
});

test('reliable: 卡片回复使用 interactive + update_multi，且更新走 patch', async () => {
  const api = new FakeFeishuApi();
  const transport = reliable(api);
  await transport.reply('oc_chat', 'om_1', { kind: 'card', card }, { threadId: 'omt_t' });
  assert.equal(api.replied[0]?.msgType, 'interactive');
  assert.match(api.replied[0]?.content ?? '', /"update_multi":true/);
  await transport.updateCard('api-reply-1', card);
  assert.equal(api.patched.length, 1);
  assert.equal(api.patched[0]?.messageId, 'api-reply-1');
});

test('reliable: 缺 update_multi 的卡片被拒绝（不离开进程）', async () => {
  const api = new FakeFeishuApi();
  const transport = reliable(api);
  const bad = { ...card, config: {} } as unknown as FeishuCard;
  await assert.rejects(transport.sendCard('oc_chat', bad), TypeError);
  await assert.rejects(transport.reply('oc_chat', 'om_1', { kind: 'card', card: bad }), TypeError);
  assert.equal(api.created.length, 0);
  assert.equal(api.replied.length, 0);
});

test('reliable: sendText/sendCard 都带 uuid', async () => {
  const api = new FakeFeishuApi();
  const transport = reliable(api);
  await transport.sendText('oc_chat', 'text');
  await transport.sendCard('oc_chat', card);
  assert.equal(api.created[0]?.uuid, 'uuid-1');
  assert.equal(api.created[1]?.uuid, 'uuid-2');
  assert.equal(api.created[1]?.msgType, 'interactive');
});
