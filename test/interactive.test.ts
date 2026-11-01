/**
 * Interactive approval/question cards: pending registry, buttons, owner check,
 * timeout, fail-closed behavior, concurrency and config switches.
 *
 * Everything is injected: no Feishu network, no waits, no real timers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { InteractiveRuntime } from '../src/interactive/runtime.js';
import type { CardAction, FeishuCard } from '../src/transport/types.js';
import { FakeClock, FakeLogger, tick } from './support/fakes.js';

interface SentCard {
  readonly messageId: string;
  readonly card: FeishuCard;
}

function buttonsOf(card: FeishuCard): {
  readonly label: string;
  readonly value: Record<string, unknown>;
}[] {
  const action = card.elements.find((element) => element.tag === 'action') as
    | { actions?: { text?: { content?: string }; value?: Record<string, unknown> }[] }
    | undefined;
  return (action?.actions ?? []).map((button) => ({
    label: button.text?.content ?? '',
    value: button.value ?? {},
  }));
}

function makeRuntime(options?: {
  approvalCard?: boolean;
  questionCard?: boolean;
  timeoutMs?: number;
  failSend?: boolean;
  updateThrows?: boolean;
}): {
  runtime: InteractiveRuntime;
  clock: FakeClock;
  logger: FakeLogger;
  sent: SentCard[];
  updates: { messageId: string; card: FeishuCard }[];
  setFailSend(value: boolean): void;
  attach(): {
    listeners: Map<string, (...args: any[]) => any>;
    context: { scopeKey: string; chatId: string; ownerOpenId: string; sessionId: string };
  };
} {
  const clock = new FakeClock();
  const logger = new FakeLogger();
  const sent: SentCard[] = [];
  const updates: { messageId: string; card: FeishuCard }[] = [];
  let failSend = options?.failSend ?? false;
  const runtime = new InteractiveRuntime({
    config: {
      approvalCard: options?.approvalCard ?? true,
      questionCard: options?.questionCard ?? true,
      timeoutMs: options?.timeoutMs ?? 300_000,
    },
    logger,
    clock,
    sendCard: async (_chatId, card) => {
      if (failSend) throw new Error('feishu send boom');
      const messageId = `m-${sent.length + 1}`;
      sent.push({ messageId, card });
      return { messageId };
    },
    updateCard: async (messageId, card) => {
      if (options?.updateThrows === true) throw new Error('patch boom');
      updates.push({ messageId, card });
    },
  });
  return {
    runtime,
    clock,
    logger,
    sent,
    updates,
    setFailSend: (value) => {
      failSend = value;
    },
    attach: () => {
      const listeners = new Map<string, (...args: any[]) => any>();
      const context = {
        scopeKey: 'oc_chat\u0000ou_user',
        chatId: 'oc_chat',
        ownerOpenId: 'ou_owner',
        sessionId: 'feishu-1',
      };
      runtime.attach(
        {
          on(name: string, listener: (...args: any[]) => any) {
            listeners.set(name, listener);
            return listener;
          },
        },
        () => context,
      );
      return { listeners, context };
    },
  };
}

function actionFor(
  value: Record<string, unknown>,
  operatorOpenId = 'ou_owner',
  messageId = 'm-1',
): CardAction {
  return { operatorOpenId, messageId, chatId: 'oc_chat', value };
}

test('审批：允许一次 → allowed-once，卡片 patch 为终态且按钮移除', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!(
    { toolName: 'bash', reason: '需要执行命令' },
    async () => 'unavailable',
  );
  await tick();
  assert.equal(h.sent.length, 1);
  const buttons = buttonsOf(h.sent[0]!.card);
  assert.deepEqual(buttons.map((button) => button.label), ['允许一次', '拒绝']);

  await h.runtime.handleCardAction(actionFor(buttons[0]!.value));
  assert.equal(await promise, 'allowed-once');
  assert.equal(h.updates.length, 1);
  const terminal = JSON.stringify(h.updates[0]!.card);
  assert.match(terminal, /已允许/);
  assert.ok(!h.updates[0]!.card.elements.some((element) => element.tag === 'action'));
  assert.equal(h.runtime.pending.size, 0);
});

test('审批：拒绝 → rejected', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  const buttons = buttonsOf(h.sent[0]!.card);
  await h.runtime.handleCardAction(actionFor(buttons[1]!.value));
  assert.equal(await promise, 'rejected');
  assert.match(JSON.stringify(h.updates[0]!.card), /已拒绝/);
});

test('审批：超时 → cancelled，卡片标已过期', async () => {
  const h = makeRuntime({ timeoutMs: 5_000 });
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  h.clock.advance(5_000);
  await tick();
  assert.equal(await promise, 'cancelled');
  assert.match(JSON.stringify(h.updates.at(-1)?.card), /已过期/);
  assert.equal(h.runtime.pending.size, 0);
});

test('审批：发卡失败 → cancelled（fail closed），日志 ERROR', async () => {
  const h = makeRuntime({ failSend: true });
  const { listeners } = h.attach();
  const outcome = await listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  assert.equal(outcome, 'cancelled');
  assert.equal(h.sent.length, 0);
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'error' && entry.message.includes('approval card send failed'),
    ),
  );
  assert.equal(h.runtime.pending.size, 0);
});

test('审批：非 owner 点击 → 不 resolve、不 patch、warn；owner 仍可完成', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  const buttons = buttonsOf(h.sent[0]!.card);

  await h.runtime.handleCardAction(actionFor(buttons[0]!.value, 'ou_intruder'));
  await tick();
  assert.equal(h.updates.length, 0);
  assert.equal(h.runtime.pending.size, 1);
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('non-owner'),
    ),
  );

  await h.runtime.handleCardAction(actionFor(buttons[0]!.value));
  assert.equal(await promise, 'allowed-once');
  assert.equal(h.updates.length, 1);
});

test('选项：3 个选项 → 3 个按钮；点击第 2 个得到对应 answers', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const promise = listeners.get('user-questions/request')!({
    questions: [
      {
        id: 'q1',
        question: '部署到哪个环境？',
        options: [{ label: 'dev' }, { label: 'staging' }, { label: 'prod' }],
      },
    ],
  });
  await tick();
  const buttons = buttonsOf(h.sent[0]!.card);
  assert.deepEqual(buttons.map((button) => button.label), ['dev', 'staging', 'prod']);

  await h.runtime.handleCardAction(actionFor(buttons[1]!.value));
  assert.deepEqual(await promise, { answers: [{ id: 'q1', selected: ['staging'] }] });
  assert.match(JSON.stringify(h.updates[0]!.card), /已选择：staging/);
  assert.ok(!h.updates[0]!.card.elements.some((element) => element.tag === 'action'));
});

test('选项：超时 → reject', async () => {
  const h = makeRuntime({ timeoutMs: 1_000 });
  const { listeners } = h.attach();
  const promise = listeners.get('user-questions/request')!({
    questions: [{ id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] }],
  });
  promise.catch(() => undefined);
  await tick();
  h.clock.advance(1_000);
  await tick();
  await assert.rejects(promise, /timed out/);
  assert.match(JSON.stringify(h.updates.at(-1)?.card), /已过期/);
});

test('选项：两个并发请求 id 不冲突、互不干扰', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const first = listeners.get('user-questions/request')!({
    questions: [{ id: 'q1', question: 'A?', options: [{ label: 'a1' }, { label: 'a2' }] }],
  });
  const second = listeners.get('user-questions/request')!({
    questions: [{ id: 'q2', question: 'B?', options: [{ label: 'b1' }, { label: 'b2' }] }],
  });
  await tick();
  assert.equal(h.sent.length, 2);
  const firstButtons = buttonsOf(h.sent[0]!.card);
  const secondButtons = buttonsOf(h.sent[1]!.card);
  assert.notEqual(firstButtons[0]!.value['id'], secondButtons[0]!.value['id']);

  await h.runtime.handleCardAction(actionFor(firstButtons[0]!.value));
  assert.deepEqual(await first, { answers: [{ id: 'q1', selected: ['a1'] }] });
  assert.equal(h.runtime.pending.size, 1);
  assert.equal(h.updates.length, 1);

  await h.runtime.handleCardAction(actionFor(secondButtons[0]!.value));
  assert.deepEqual(await second, { answers: [{ id: 'q2', selected: ['b1'] }] });
  assert.equal(h.runtime.pending.size, 0);
});

test('选项：多问题或 >4 选项 → 纯文本卡（无按钮）并提示回复文字', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const promise = listeners.get('user-questions/request')!({
    questions: [
      { id: 'q1', question: '多问题 1', options: [{ label: 'a' }] },
      { id: 'q2', question: '多问题 2', options: [{ label: 'b' }] },
    ],
  });
  promise.catch(() => undefined);
  await tick();
  const card = h.sent[0]!.card;
  assert.equal(buttonsOf(card).length, 0);
  assert.match(JSON.stringify(card), /本版暂不支持在卡片内输入文字/);
  h.clock.advance(300_000);
  await tick();
  await assert.rejects(promise, /timed out/);
});

test('配置关闭：审批 → unavailable，选项 → reject，均不发卡', async () => {
  const approval = makeRuntime({ approvalCard: false });
  const a = approval.attach();
  const outcome = await a.listeners.get('approval/request')!(
    { toolName: 'bash' },
    async () => 'unavailable',
  );
  assert.equal(outcome, 'unavailable');
  assert.equal(approval.sent.length, 0);

  const questions = makeRuntime({ questionCard: false });
  const q = questions.attach();
  await assert.rejects(
    q.listeners.get('user-questions/request')!({
      questions: [{ id: 'q', question: '?', options: [{ label: 'x' }] }],
    }),
    /disabled/,
  );
  assert.equal(questions.sent.length, 0);
});

test('卡片 patch 失败不影响 resolve（只 warn）', async () => {
  const h = makeRuntime({ updateThrows: true });
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  const buttons = buttonsOf(h.sent[0]!.card);
  await h.runtime.handleCardAction(actionFor(buttons[0]!.value));
  assert.equal(await promise, 'allowed-once');
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'warn' && entry.message.includes('patch failed'),
    ),
  );
});

test('诊断日志：attach 成功与跳过（warn）', async () => {
  const h = makeRuntime();
  h.attach();
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' &&
        entry.message === 'interactive: attached to agent scope (total=1)',
    ),
  );

  assert.equal(h.runtime.attach({ foo: 1 }, () => undefined), false);
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'warn' &&
        entry.message === 'interactive: attach skipped (not an agent scope: object keys=foo)',
    ),
  );
});

test('诊断日志：答者入口与 sendCard 前后', async () => {
  const h = makeRuntime();
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' &&
        /^interactive: approval request id=.+ questions=0 scope=/.test(entry.message),
    ),
  );
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'interactive: approval card sending chat=oc_chat',
    ),
  );
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'interactive: approval card sent messageId=m-1',
    ),
  );

  const question = listeners.get('user-questions/request')!({
    questions: [{ id: 'q1', question: '?', options: [{ label: 'a' }] }],
  });
  question.catch(() => undefined);
  await tick();
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' &&
        /^interactive: question request id=.+ questions=1 scope=/.test(entry.message),
    ),
  );

  const buttons = buttonsOf(h.sent[0]!.card);
  await h.runtime.handleCardAction(actionFor(buttons[0]!.value));
  assert.equal(await promise, 'allowed-once');
  h.clock.advance(300_000);
  await tick();
  await assert.rejects(question, /timed out/);
});

test('诊断日志：点击、未知 id、超时', async () => {
  const h = makeRuntime({ timeoutMs: 1_000 });
  const { listeners } = h.attach();
  const promise = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  const buttons = buttonsOf(h.sent[0]!.card);

  await h.runtime.handleCardAction(actionFor({ id: 'missing', kind: 'approval' }));
  assert.ok(
    h.logger.entries.some(
      (entry) => entry.level === 'info' && entry.message === 'card action ignored (unknown id)',
    ),
  );
  await h.runtime.handleCardAction(actionFor({}, 'ou_owner', 'm-1'));
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' && entry.message === 'card action ignored (unknown id)',
    ),
  );

  await h.runtime.handleCardAction(actionFor(buttons[0]!.value));
  assert.equal(await promise, 'allowed-once');
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' &&
        /^card action id=.+ kind=approval operator=ou_owner$/.test(entry.message),
    ),
  );

  const second = listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  await tick();
  h.clock.advance(1_000);
  await tick();
  assert.equal(await second, 'cancelled');
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'info' &&
        entry.message === 'interactive: approval timed out after 1000ms',
    ),
  );
});

test('诊断日志：config 关闭与 sendCard 失败', async () => {
  const disabled = makeRuntime({ approvalCard: false });
  const d = disabled.attach();
  await d.listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  assert.ok(
    disabled.logger.entries.some(
      (entry) =>
        entry.level === 'warn' &&
        entry.message === 'interactive: approval skipped (approvalCard disabled)',
    ),
  );

  const h = makeRuntime({ failSend: true });
  const { listeners } = h.attach();
  const outcome = await listeners.get('approval/request')!({ toolName: 'bash' }, async () => 'unavailable');
  assert.equal(outcome, 'cancelled');
  assert.ok(
    h.logger.entries.some(
      (entry) =>
        entry.level === 'error' &&
        entry.message === 'interactive: approval card send failed: feishu send boom',
    ),
  );
});
