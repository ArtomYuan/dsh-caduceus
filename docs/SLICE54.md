# 第五十四刀：修 file/image 上传响应形状 + 部署版本号对齐

状态：**代码与单测完成；需同步并重启后真机验证。**
未改 dsh 源码/profile、未重启、未安装。

## 0. 真机证据

```
WARN media send failed for .caduceus-export-….md:
     feishu im.v1.file.create failed: unknown error
```

本机 `@larksuiteoapi/node-sdk` 的 `im.v1.file.create` 直接返回裸 data
（`{"file_key":"file_v3_…"}`），不包 `{code,msg,data}`。旧代码 `assertOk(response)`
把 `code === undefined` 当失败（-1）→ unknown error。curl 直连同接口是 `code:0`，权限/网络正常。

## 1. 上传响应 unwrap

新增 `src/transport/feishu-response.ts`：

```ts
export function unwrapFeishuData<T extends object>(response: unknown, operation: string): T {
  // 有 code：code !== 0 抛 FeishuApiError(code, msg)；否则取 data
  // 无 code：裸 data，直接返回
}
```

- `uploadFile`、`uploadImage` 改用它；
- `file_key` / `image_key` 缺失仍抛错，错误信息写明接口
  （`feishu im.v1.file.create returned no file_key`）；
- 信封错误信息带 code：`feishu im.v1.file.create failed (code 10001): x`。

### `assertOk` 扫描结果

- **改了**：`im.v1.file.create`、`im.v1.image.create`（可能裸 data）。
- **没改**（已验过是信封）：
  - `im.v1.message.create` / `message.reply`（`messageIdOf` → `assertOk`）
  - `im.v1.message.patch`
  - `im.v1.message.reaction.create` / `.delete`
  - `messageResource.get` 走 stream/headers，不走 assertOk
- 其它接口保持现状，避免把已验证的信封接口误当裸 data。

## 2. 部署脚本

新增 `scripts/deploy.sh`：

- 从仓库 `package.json` 读 version；
- 定位目标 profile 下已安装的 `dsh-caduceus`（`require.resolve`）；
- `rm -rf` + `cp -a` 同步 `dist/`；
- 用 Node 把生产包 `package.json.version` 改成当前版本；
- 目标默认 `$HOME/.dsh/profiles/web`，可用 `CADUCEUS_DEPLOY_TARGET` 覆盖；
- **不含 systemctl**；重启由宿主侧决定。

## 3. 版本

0.10.1。

## 4. 测试

原有 361 例保留，新增 7 例，共 **368** 全绿（`test/lark-upload.test.ts`）：

- file：信封 `{code:0,data:{file_key}}` → key；
- file：裸 `{file_key}` → key；
- file：`{code:10001,msg:'x'}` → 抛错含 10001/x；
- file：裸 `{}` → `no file_key`；
- image：信封 / 裸 `{image_key}` 各一条；
- image：裸 `{}` → `no image_key`。

## 5. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | /export 发文件 | `/export` 后话题内收到 `.md` 文件，不再 unknown error |
| 2 | 图片发送 | agent `MEDIA:` 图片能上传并发送 |
| 3 | 版本对齐 | 部署后 `/doctor` 版本显示 0.10.1 |
| 4 | 错误可读 | 若上传真失败，日志信息含接口与 code/msg |

## 6. 约束与遗留

- 未 npm publish、未安装、未重启；真机需同步 dist 并重启。
- 部署脚本只同步 dist/与版本号，不启动/停止服务。
- `docs/DESIGN.md` 未触碰；profile 未改。
