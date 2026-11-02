/** Permission panel: current label + usage + buttons only; zh/en; no tech values. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPermissionCard,
  PERMISSION_SWITCH_ACTION,
  renderPermissionText,
  type PermissionView,
} from '../src/render/permission-card.js';
import type { FeishuCardElement } from '../src/transport/types.js';

const PRESETS = [
  { name: 'read-only', resolved: true },
  { name: 'workspace-write', resolved: true },
  { name: 'danger-full-access', resolved: true },
  { name: 'auto', resolved: true },
] as const;

function view(lang: PermissionView['lang'], current: string): PermissionView {
  return { lang, current, presets: [...PRESETS] };
}

function buttons(card: { elements: readonly FeishuCardElement[] }) {
  const action = card.elements.find((element) => element.tag === 'action') as
    | {
        actions?: {
          text?: { content?: string };
          disabled?: boolean;
          value?: Record<string, unknown>;
        }[];
      }
    | undefined;
  return action?.actions ?? [];
}

function divLines(card: { elements: readonly FeishuCardElement[] }): string[] {
  return card.elements
    .filter((element) => element.tag === 'div')
    .map((element) => element.text?.content ?? '');
}

test('zh 卡片：当前档位 + 用法 + 四按钮，无技术值', () => {
  const card = buildPermissionCard(view('zh', 'workspace-write'));
  assert.equal(card.header?.title.content, '权限 · 当前：工作区内修改');
  assert.deepEqual(divLines(card), ['用法：/permission <档位>，或点下方按钮']);
  assert.deepEqual(
    buttons(card).map((button) => button.text?.content),
    ['仅可查看', '工作区内修改', '完全权限', '自动审查（EXP）'],
  );
  const text = JSON.stringify(card);
  for (const word of ['沙箱', '审批', 'sandbox', 'approval']) {
    assert.ok(!text.includes(word), `card must not contain ${word}`);
  }
});

test('en 卡片：Permission · current + Usage + four buttons, no tech values', () => {
  const card = buildPermissionCard(view('en', 'workspace-write'));
  assert.equal(card.header?.title.content, 'Permission · current: Workspace Write');
  assert.deepEqual(divLines(card), [
    'Usage: /permission <preset>, or tap a button below',
  ]);
  assert.deepEqual(
    buttons(card).map((button) => button.text?.content),
    ['Read Only', 'Workspace Write', 'Full access', 'Auto review (EXP)'],
  );
  const text = JSON.stringify(card);
  for (const word of ['沙箱', '审批', 'sandbox', 'approval']) {
    assert.ok(!text.includes(word), `card must not contain ${word}`);
  }
});

test('custom 标题与文本降级：三项，无技术值', () => {
  const data = view('zh', 'custom');
  const card = buildPermissionCard(data);
  assert.equal(card.header?.title.content, '权限 · 当前：自定义（不匹配任何预设）');
  assert.match(
    JSON.stringify(card),
    /权限 · 当前：自定义（不匹配任何预设）/,
  );
  const text = renderPermissionText(data);
  assert.equal(
    text,
    [
      '权限 · 当前：自定义（不匹配任何预设）',
      '用法：/permission <档位>，或点下方按钮',
      '仅可查看 / 工作区内修改 / 完全权限 / 自动审查（EXP）',
    ].join('\n'),
  );
  for (const word of ['沙箱', '审批', 'sandbox', 'approval']) {
    assert.ok(!text.includes(word));
  }
});

test('当前档位按钮置灰，其他可点；value 仍带原名', () => {
  const card = buildPermissionCard(view('zh', 'workspace-write'));
  const actions = buttons(card);
  const current = actions.find((button) => button.text?.content === '工作区内修改');
  assert.equal(current?.disabled, true);
  assert.deepEqual(current?.value, {
    action: PERMISSION_SWITCH_ACTION,
    name: 'workspace-write',
  });
  assert.equal(
    actions.find((button) => button.text?.content === '仅可查看')?.disabled,
    undefined,
  );
});

test('未知档位：标签回退原名，仍可出现在按钮与标题', () => {
  const data: PermissionView = {
    lang: 'zh',
    current: 'weird-preset',
    presets: [{ name: 'weird-preset', resolved: false }],
  };
  const card = buildPermissionCard(data);
  assert.equal(card.header?.title.content, '权限 · 当前：weird-preset');
  assert.deepEqual(
    buttons(card).map((button) => button.text?.content),
    ['weird-preset'],
  );
});

test('文本降级：具体预设也是三项，且不含技术值', () => {
  const text = renderPermissionText(view('zh', 'read-only'));
  assert.deepEqual(text.split('\n'), [
    '权限 · 当前：仅可查看',
    '用法：/permission <档位>，或点下方按钮',
    '仅可查看 / 工作区内修改 / 完全权限 / 自动审查（EXP）',
  ]);
  for (const word of ['沙箱', '审批', 'sandbox', 'approval']) {
    assert.ok(!text.includes(word));
  }
});

test('en custom 标签与文本', () => {
  const text = renderPermissionText(view('en', 'custom'));
  assert.match(text, /^Permission · current: Custom \(matches no preset\)/);
  assert.match(text, /Usage: \/permission <preset>, or tap a button below/);
  assert.match(text, /Read Only \/ Workspace Write \/ Full access \/ Auto review \(EXP\)/);
});
