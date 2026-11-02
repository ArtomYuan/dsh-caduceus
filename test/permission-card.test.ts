/** Permission card/text renderer: same data, zh/en, buttons. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPermissionCard,
  PERMISSION_SWITCH_ACTION,
  renderPermissionText,
  type PermissionView,
} from '../src/render/permission-card.js';
import type { FeishuCardElement } from '../src/transport/types.js';

function view(lang: PermissionView['lang'], current: string): PermissionView {
  return {
    lang,
    current,
    presets: [
      { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask', resolved: true },
      { name: 'auto', resolved: false },
    ],
  };
}

function buttons(card: { elements: readonly FeishuCardElement[] }) {
  const action = card.elements.find((element) => element.tag === 'action') as
    | { actions?: { text?: { content?: string }; value?: Record<string, unknown> }[] }
    | undefined;
  return action?.actions ?? [];
}

test('zh 卡片：当前档位、实测值、提示、按钮', () => {
  const card = buildPermissionCard(view('zh', 'workspace-write'));
  const text = JSON.stringify(card);
  assert.equal(card.header?.title.content, '权限档位');
  assert.match(text, /当前档位：workspace-write/);
  assert.match(text, /- workspace-write：沙箱 workspace-write · 审批 ask（可写会话工作区，越界需审批）/);
  assert.match(text, /- auto/);
  assert.match(text, /用法：\/permission <档位>/);
  assert.equal(buttons(card).length, 2);
});

test('en 卡片：内容等价但英文', () => {
  const card = buildPermissionCard(view('en', 'workspace-write'));
  const text = JSON.stringify(card);
  assert.equal(card.header?.title.content, 'Permission preset');
  assert.match(text, /Current preset: workspace-write/);
  assert.match(text, /sandbox workspace-write · approval ask/);
  assert.match(text, /Usage: \/permission <preset>/);
});

test('卡片与文本渲染用同一份行数据', () => {
  const data = view('zh', 'custom');
  const text = renderPermissionText(data);
  const cardText = JSON.stringify(buildPermissionCard(data));
  for (const line of text.split('\n')) {
    assert.ok(cardText.includes(line), `card missing line: ${line}`);
  }
  assert.match(text, /当前档位：custom（当前沙箱\/审批组合不匹配任何预设）/);
  assert.match(text, /用 \/permission <档位> 回到某个预设/);
});

test('按钮 payload：action + name', () => {
  const card = buildPermissionCard(view('zh', 'workspace-write'));
  const actions = buttons(card);
  assert.deepEqual(actions[0]?.value, {
    action: 'caduceus.permission.switch',
    name: 'workspace-write',
  });
  assert.equal(PERMISSION_SWITCH_ACTION, 'caduceus.permission.switch');
});
