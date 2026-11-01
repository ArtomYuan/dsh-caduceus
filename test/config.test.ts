/**
 * Gateway config resolution: the ordinary-group isolation switch and
 * credential/env fallbacks. Pure — no filesystem, no dsh runtime.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGatewayConfig } from '../src/config.js';

test('resolveGatewayConfig: groupSessionsPerUser 默认 true，可显式关闭', () => {
  const defaults = resolveGatewayConfig({}, {}, '/tmp/work');
  assert.equal(defaults.bridge.groupSessionsPerUser, true);
  assert.equal(defaults.bridge.defaultCwd, '/tmp/work');
  assert.equal(defaults.credentials, undefined);

  const off = resolveGatewayConfig({ groupSessionsPerUser: false }, {}, '/tmp/work');
  assert.equal(off.bridge.groupSessionsPerUser, false);

  const on = resolveGatewayConfig({ groupSessionsPerUser: true }, {}, '/tmp/work');
  assert.equal(on.bridge.groupSessionsPerUser, true);
});

test('resolveGatewayConfig: 凭据先取配置、再取 FEISHU_APP_ID/SECRET，并透传其他项', () => {
  const env = { FEISHU_APP_ID: 'env-app', FEISHU_APP_SECRET: 'env-secret' };
  assert.deepEqual(resolveGatewayConfig({}, env, '/tmp/work').credentials, {
    appId: 'env-app',
    appSecret: 'env-secret',
  });

  const explicit = resolveGatewayConfig(
    {
      appId: 'cfg-app',
      appSecret: 'cfg-secret',
      cardThrottleMs: 250,
      busyMode: 'steer',
      allowedChats: ['oc_x'],
      allowedUsers: ['ou_y'],
    },
    env,
    '/tmp/work',
  );
  assert.deepEqual(explicit.credentials, { appId: 'cfg-app', appSecret: 'cfg-secret' });
  assert.equal(explicit.bridge.cardThrottleMs, 250);
  assert.equal(explicit.bridge.busyMode, 'steer');
  assert.deepEqual(explicit.bridge.allowedChats, ['oc_x']);
  assert.deepEqual(explicit.bridge.allowedUsers, ['ou_y']);
});

test('resolveGatewayConfig: logLevel 默认 info，可配 debug', () => {
  assert.equal(resolveGatewayConfig({}, {}, '/tmp/work').logLevel, 'info');
  assert.equal(resolveGatewayConfig({ logLevel: 'debug' }, {}, '/tmp/work').logLevel, 'debug');
});


test('resolveGatewayConfig: personaAutoSync 默认 true，可配置 false', () => {
  assert.equal(resolveGatewayConfig({}, {}, '/tmp/work').personaAutoSync, true);
  assert.equal(
    resolveGatewayConfig({ personaAutoSync: false }, {}, '/tmp/work').personaAutoSync,
    false,
  );
});

test('resolveGatewayConfig: agentPreset 默认 standard，可配置 other', () => {
  assert.equal(resolveGatewayConfig({}, {}, '/tmp/work').agentPreset, 'standard');
  assert.equal(resolveGatewayConfig({}, {}, '/tmp/work').bridge.agentPreset, 'standard');
  assert.equal(
    resolveGatewayConfig({ agentPreset: 'other' }, {}, '/tmp/work').agentPreset,
    'other',
  );
  assert.equal(
    resolveGatewayConfig({ agentPreset: 'other' }, {}, '/tmp/work').bridge.agentPreset,
    'other',
  );
});

test('交互卡片配置默认开启、超时 300s；显式关闭生效', async () => {
  const { DEFAULT_APPROVAL_CARD, DEFAULT_QUESTION_CARD, DEFAULT_INTERACTIVE_TIMEOUT_MS } =
    await import('../src/config.js');
  assert.equal(DEFAULT_APPROVAL_CARD, true);
  assert.equal(DEFAULT_QUESTION_CARD, true);
  assert.equal(DEFAULT_INTERACTIVE_TIMEOUT_MS, 300_000);

  const { resolveGatewayConfig } = await import('../src/config.js');
  const defaults = resolveGatewayConfig({});
  assert.equal(defaults.approvalCard, true);
  assert.equal(defaults.questionCard, true);
  assert.equal(defaults.interactiveTimeoutMs, 300_000);

  const off = resolveGatewayConfig({ approvalCard: false, questionCard: false, interactiveTimeoutMs: 5 });
  assert.equal(off.approvalCard, false);
  assert.equal(off.questionCard, false);
  assert.equal(off.interactiveTimeoutMs, 5);
});

test('approvalPolicy 默认 ask，可显式设为 never', async () => {
  const { DEFAULT_APPROVAL_POLICY, resolveGatewayConfig } = await import('../src/config.js');
  assert.equal(DEFAULT_APPROVAL_POLICY, 'ask');
  assert.equal(resolveGatewayConfig({}).approvalPolicy, 'ask');
  assert.equal(resolveGatewayConfig({ approvalPolicy: 'never' }).approvalPolicy, 'never');
});
