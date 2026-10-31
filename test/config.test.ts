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
