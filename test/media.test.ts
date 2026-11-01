/** MEDIA marker parsing and the outbound path safety boundary. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractMediaMarkers, resolveMedia } from '../src/media.js';

test('extractMediaMarkers：剥除一行一个 MEDIA 标记，正文保留', () => {
  const parsed = extractMediaMarkers(
    '报告如下\nMEDIA:/tmp/a.png\n第二段\nMEDIA:/tmp/b.pdf\n',
  );
  assert.equal(parsed.text, '报告如下\n第二段');
  assert.deepEqual(parsed.paths, ['/tmp/a.png', '/tmp/b.pdf']);
  assert.deepEqual(extractMediaMarkers('没有标记').paths, []);
});

test('resolveMedia：绝对路径、root 内、大小限制；相对/不存在/越界拒绝', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-media-test-'));
  const outside = mkdtempSync(join(tmpdir(), 'dsh-media-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const inside = join(root, 'a.png');
  writeFileSync(inside, Buffer.alloc(100));
  const outsideFile = join(outside, 'b.png');
  writeFileSync(outsideFile, Buffer.alloc(100));
  const limits = { roots: [root], maxFileBytes: 1000, maxImageBytes: 1000 };

  const ok = resolveMedia(inside, limits);
  assert.equal(ok.ok, true);
  assert.equal((ok as { name: string }).name, 'a.png');
  assert.equal((ok as { image: boolean }).image, true);

  assert.deepEqual(resolveMedia('relative.png', limits), {
    ok: false,
    name: 'relative.png',
    reason: '仅支持绝对路径',
  });
  assert.equal(resolveMedia(join(root, 'missing.png'), limits).ok, false);
  assert.deepEqual(resolveMedia(outsideFile, limits), {
    ok: false,
    name: 'b.png',
    reason: '路径不在允许目录内',
  });
  assert.deepEqual(
    resolveMedia(inside, { roots: [root], maxFileBytes: 1000, maxImageBytes: 50 }),
    { ok: false, name: 'a.png', reason: '超过大小限制' },
  );
});
