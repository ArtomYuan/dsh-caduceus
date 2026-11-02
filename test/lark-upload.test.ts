/** File/image upload response shapes: envelope {code,data} and bare data. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LarkFeishuApi } from '../src/transport/lark.js';

type UploadStub = () => Promise<unknown>;

function larkWith(file: UploadStub, image: UploadStub): LarkFeishuApi {
  const lark = new LarkFeishuApi({ appId: 'app', appSecret: 'secret', logger: undefined });
  (lark as unknown as {
    client: {
      im: { v1: { file: { create: UploadStub }; image: { create: UploadStub } } };
    };
  }).client = {
    im: { v1: { file: { create: file }, image: { create: image } } },
  };
  return lark;
}

const bytes = new Uint8Array([1, 2, 3]);

test('uploadFile：信封 {code:0,data:{file_key}} → key', async () => {
  const lark = larkWith(async () => ({ code: 0, data: { file_key: 'file_env' } }), async () => ({}));
  assert.equal(await lark.uploadFile('a.md', bytes), 'file_env');
});

test('uploadFile：裸 {file_key} → key', async () => {
  const lark = larkWith(async () => ({ file_key: 'file_bare' }), async () => ({}));
  assert.equal(await lark.uploadFile('a.md', bytes), 'file_bare');
});

test('uploadFile：信封 {code:10001,msg:"x"} → 抛错含 code/msg', async () => {
  const lark = larkWith(
    async () => ({ code: 10001, msg: 'x', data: {} }),
    async () => ({}),
  );
  await assert.rejects(lark.uploadFile('a.md', bytes), /10001.*x|feishu .*10001/);
});

test('uploadFile：裸 {} → 抛 no file_key', async () => {
  const lark = larkWith(async () => ({}), async () => ({}));
  await assert.rejects(lark.uploadFile('a.md', bytes), /no file_key/);
});

test('uploadImage：信封 {code:0,data:{image_key}} → key', async () => {
  const lark = larkWith(async () => ({}), async () => ({ code: 0, data: { image_key: 'img_env' } }));
  assert.equal(await lark.uploadImage(bytes), 'img_env');
});

test('uploadImage：裸 {image_key} → key', async () => {
  const lark = larkWith(async () => ({}), async () => ({ image_key: 'img_bare' }));
  assert.equal(await lark.uploadImage(bytes), 'img_bare');
});

test('uploadImage：裸 {} → 抛 no image_key', async () => {
  const lark = larkWith(async () => ({}), async () => ({}));
  await assert.rejects(lark.uploadImage(bytes), /no image_key/);
});
