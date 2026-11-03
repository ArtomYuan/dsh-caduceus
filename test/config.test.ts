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

test('approvalPolicy 默认不覆盖（undefined），可显式设置', async () => {
  const { resolveGatewayConfig } = await import('../src/config.js');
  assert.equal(resolveGatewayConfig({}).approvalPolicy, undefined);
  assert.equal(resolveGatewayConfig({ approvalPolicy: 'ask' }).approvalPolicy, 'ask');
  assert.equal(resolveGatewayConfig({ approvalPolicy: 'never' }).approvalPolicy, 'never');
});

test('reactions 默认开启，四个配置项可覆盖', async () => {
  const {
    DEFAULT_REACTIONS,
    DEFAULT_REACTION_ON_START,
    DEFAULT_REACTION_ON_DONE,
    DEFAULT_REACTION_ON_FAIL,
    resolveGatewayConfig,
  } = await import('../src/config.js');
  assert.equal(DEFAULT_REACTIONS, true);
  assert.equal(DEFAULT_REACTION_ON_START, 'OnIt');
  assert.equal(DEFAULT_REACTION_ON_DONE, 'DONE');
  assert.equal(DEFAULT_REACTION_ON_FAIL, 'CROSS_MARK');
  const defaults = resolveGatewayConfig({});
  assert.deepEqual(
    {
      reactions: defaults.bridge.reactions,
      start: defaults.bridge.reactionOnStart,
      done: defaults.bridge.reactionOnDone,
      fail: defaults.bridge.reactionOnFail,
    },
    { reactions: true, start: 'OnIt', done: 'DONE', fail: 'CROSS_MARK' },
  );
  const custom = resolveGatewayConfig({
    reactions: false,
    reactionOnStart: 'THINKING',
    reactionOnDone: 'THUMBSUP',
    reactionOnFail: 'SMILE',
  });
  assert.equal(custom.bridge.reactions, false);
  assert.equal(custom.bridge.reactionOnStart, 'THINKING');
  assert.equal(custom.bridge.reactionOnDone, 'THUMBSUP');
  assert.equal(custom.bridge.reactionOnFail, 'SMILE');
});

test('gateRequireBotIdentity 默认 true，可显式关闭', async () => {
  const { resolveGatewayConfig } = await import('../src/config.js');
  assert.equal(resolveGatewayConfig({}).bridge.gateRequireBotIdentity, true);
  assert.equal(
    resolveGatewayConfig({ gateRequireBotIdentity: false }).bridge.gateRequireBotIdentity,
    false,
  );
});

test('附件配置默认开启、20MB；可覆盖', async () => {
  const {
    DEFAULT_IMAGES,
    DEFAULT_FILES,
    DEFAULT_MAX_ATTACHMENT_BYTES,
    resolveGatewayConfig,
  } = await import('../src/config.js');
  assert.equal(DEFAULT_IMAGES, true);
  assert.equal(DEFAULT_FILES, true);
  assert.equal(DEFAULT_MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  const defaults = resolveGatewayConfig({});
  assert.equal(defaults.bridge.images, true);
  assert.equal(defaults.bridge.files, true);
  assert.equal(defaults.bridge.maxAttachmentBytes, 20 * 1024 * 1024);
  const custom = resolveGatewayConfig({
    images: false,
    files: false,
    maxAttachmentBytes: 1024,
  });
  assert.equal(custom.bridge.images, false);
  assert.equal(custom.bridge.files, false);
  assert.equal(custom.bridge.maxAttachmentBytes, 1024);
});

test('发送媒体配置默认值/覆盖', async () => {
  const {
    DEFAULT_SEND_MEDIA,
    DEFAULT_MAX_SEND_FILE_BYTES,
    DEFAULT_MAX_SEND_IMAGE_BYTES,
    resolveGatewayConfig,
  } = await import('../src/config.js');
  assert.equal(DEFAULT_SEND_MEDIA, true);
  assert.equal(DEFAULT_MAX_SEND_FILE_BYTES, 30 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_SEND_IMAGE_BYTES, 10 * 1024 * 1024);
  const defaults = resolveGatewayConfig({});
  assert.equal(defaults.bridge.sendMedia, true);
  assert.equal(defaults.bridge.maxSendFileBytes, 30 * 1024 * 1024);
  assert.equal(defaults.bridge.maxSendImageBytes, 10 * 1024 * 1024);
  assert.deepEqual(defaults.bridge.mediaRoots, []);
  const custom = resolveGatewayConfig({
    sendMedia: false,
    maxSendFileBytes: 100,
    maxSendImageBytes: 50,
    mediaRoots: ['/tmp'],
  });
  assert.equal(custom.bridge.sendMedia, false);
  assert.equal(custom.bridge.maxSendFileBytes, 100);
  assert.equal(custom.bridge.maxSendImageBytes, 50);
  assert.deepEqual(custom.bridge.mediaRoots, ['/tmp']);
});

test('admins 默认空（访问控制关闭），可配置白名单', async () => {
  const { resolveGatewayConfig } = await import('../src/config.js');
  assert.deepEqual(resolveGatewayConfig({}).bridge.admins, []);
  assert.deepEqual(resolveGatewayConfig({ admins: ['ou_a'] }).bridge.admins, ['ou_a']);
});

test('accessControlWarning：空 admins 返回禁用警告', async () => {
  const { accessControlWarning } = await import('../src/config.js');
  assert.equal(
    accessControlWarning([]),
    'access control disabled (no admins configured)',
  );
  assert.equal(accessControlWarning(['ou_admin']), undefined);
});

test('lang 默认 zh，可设 en/auto', async () => {
  const { resolveGatewayConfig } = await import('../src/config.js');
  assert.equal(resolveGatewayConfig({}).lang, 'zh');
  assert.equal(resolveGatewayConfig({ lang: 'en' }).lang, 'en');
  assert.equal(resolveGatewayConfig({ lang: 'auto' }).lang, 'auto');
});

test('metrics 默认 compact，可 off/detailed', async () => {
  const { resolveGatewayConfig } = await import('../src/config.js');
  assert.equal(resolveGatewayConfig({}).bridge.metrics, 'compact');
  assert.equal(resolveGatewayConfig({ metrics: 'off' }).bridge.metrics, 'off');
  assert.equal(resolveGatewayConfig({ metrics: 'detailed' }).bridge.metrics, 'detailed');
});
