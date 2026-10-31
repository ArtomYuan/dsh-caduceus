/**
 * Startup ownership backfill + ownership sidecar tests.
 * All layouts live under mkdtemp; the real `~/.dsh` is never touched.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { backfillSessionOwnership, scanSessionDirs } from '../src/backfill.js';
import {
  ownershipPath,
  readOwnership,
  writeOwnership,
  type SessionOwnershipMeta,
} from '../src/ownership.js';
import { SessionStore } from '../src/session-key.js';
import { FakeLogger } from './support/fakes.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-caduceus-backfill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sessionDir(root: string, bucket: string, sessionId: string): string {
  const dir = join(root, bucket, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const ownerA: SessionOwnershipMeta = {
  chatId: 'oc_a',
  scopeKey: 'oc_a\u0000ou_a',
  kind: 'group-user',
};
const ownerB: SessionOwnershipMeta = {
  chatId: 'oc_a',
  scopeKey: 'oc_a\u0000omt_t',
  kind: 'topic',
};

test('backfill：扫描 3 条会话（2 带 meta、1 不带）→ adopted=2/skipped=1，且幂等', (t) => {
  const dir = makeDir(t);
  const root = join(dir, 'sessions');

  // 1) sidecar inside the session directory
  const s1 = sessionDir(root, '--proj-a--', 'feishu-1111111111111');
  writeFileSync(join(s1, 'caduceus-owner.json'), JSON.stringify({ caduceus: ownerA }));

  // 2) ownership embedded in a plain JSONL header (`meta.caduceus`)
  const s2 = sessionDir(root, '--proj-a--', 'feishu-2222222222222');
  writeFileSync(
    join(s2, 'session.v5.jsonl'),
    `${JSON.stringify({
      type: 'session',
      version: 5,
      id: 'feishu-2222222222222',
      createdAt: 1,
      meta: { caduceus: ownerB },
    })}\n`,
  );

  // 3) no caduceus metadata at all
  const s3 = sessionDir(root, '--proj-b--', 'feishu-3333333333333');
  writeFileSync(
    join(s3, 'session.v5.jsonl'),
    `${JSON.stringify({ type: 'session', version: 5, id: 'feishu-3333333333333', createdAt: 1 })}\n`,
  );

  const store = new SessionStore({ filePath: join(dir, 'session-map.json') });
  store.load();
  const logger = new FakeLogger();
  const options = {
    root,
    logger,
    ownership: { dir: join(dir, 'owners') },
  };

  assert.equal(scanSessionDirs(options).length, 3);

  const first = backfillSessionOwnership(store, options);
  assert.deepEqual(first, { scanned: 3, adopted: 2, skipped: 1 });
  assert.ok(store.history(ownerA.scopeKey).includes('feishu-1111111111111'));
  assert.ok(store.history(ownerB.scopeKey).includes('feishu-2222222222222'));
  assert.equal(store.get(ownerA.scopeKey), 'feishu-1111111111111');
  assert.ok(logger.entries.some((entry) => entry.message === 'backfill: scanned=3 adopted=2 skipped=1'));

  const second = backfillSessionOwnership(store, options);
  assert.deepEqual(second, { scanned: 3, adopted: 0, skipped: 1 }, 'idempotent');
});

test('ownership：写入/读取 sidecar，路径安全且内容可校验', async (t) => {
  const dir = makeDir(t);
  const meta: SessionOwnershipMeta = { chatId: 'oc_x', scopeKey: 'oc_x', kind: 'p2p' };
  await writeOwnership('feishu-4444444444444', meta, { dir });

  assert.ok(existsSync(ownershipPath('feishu-4444444444444', { dir })));
  assert.deepEqual(readOwnership('feishu-4444444444444', { dir }), meta);
  assert.equal(readOwnership('../bad', { dir }), undefined);
  const raw = JSON.parse(
    readFileSync(ownershipPath('feishu-4444444444444', { dir }), 'utf8'),
  ) as { caduceus: SessionOwnershipMeta };
  assert.deepEqual(raw.caduceus, meta);
});
