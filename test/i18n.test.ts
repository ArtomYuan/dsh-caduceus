/** Locale resolution: dsh settings first, then LC_ALL/LANG, then zh. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLang, t } from '../src/i18n.js';

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('resolveLang：无 settings、无 env → zh', () => {
  withEnv({ LC_ALL: undefined, LANG: undefined }, () => {
    assert.equal(resolveLang(), 'zh');
  });
});

test('resolveLang：LANG=zh_CN → zh', () => {
  withEnv({ LC_ALL: undefined, LANG: 'zh_CN.UTF-8' }, () => {
    assert.equal(resolveLang(), 'zh');
  });
});

test('resolveLang：LANG=en_US → en', () => {
  withEnv({ LC_ALL: undefined, LANG: 'en_US.UTF-8' }, () => {
    assert.equal(resolveLang(), 'en');
  });
});

test('resolveLang：settings locale.get preference 优先于 env', () => {
  withEnv({ LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' }, () => {
    const settings = {
      get: (ns: string) =>
        ns === 'locale' ? { get: () => ({ preference: 'en' }) } : undefined,
    };
    assert.equal(resolveLang(() => settings), 'en');
  });
});

test('resolveLang：settings.describe 回退可用；settings 抛错不崩', () => {
  withEnv({ LC_ALL: undefined, LANG: undefined }, () => {
    const described = {
      describe: () => [{ ns: 'locale', value: { preference: 'en' } }],
    };
    assert.equal(resolveLang(() => described), 'en');
    const broken = {
      get: () => {
        throw new Error('settings unavailable');
      },
    };
    assert.equal(resolveLang(() => broken), 'zh');
  });
});

test('t：zh/en 字典字段成套且不同', () => {
  const zh = t('zh');
  const en = t('en');
  assert.notEqual(zh.permissionTitle, en.permissionTitle);
  assert.equal(zh.approvalLabel('ask'), '人工确认');
  assert.equal(en.approvalLabel('ask'), 'manual confirmation');
  assert.equal(zh.approvalLine('workspace-write', zh.approvalLabel('ask')), '档位 workspace-write · 审批 人工确认');
  assert.equal(en.approvalLine('workspace-write', en.approvalLabel('ask')), 'preset workspace-write · approval manual confirmation');
});
