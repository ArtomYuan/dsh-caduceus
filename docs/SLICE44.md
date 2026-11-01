# 第四十四刀：agent 产物发回飞书（收发闭环）

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 约定与接口

- agent 最终答复里一行一个 `MEDIA:/abs/path`；
- 文件：`im/v1/files` → file_key，`msg_type=file`；
- 图片（png/jpg/jpeg/webp/gif）：`im/v1/images` → image_key，`msg_type=image`；
- 发送复用 `transport.reply(...) + reply_in_thread`，与过程卡/交互卡同一话题路径；
- 文件 ≤30MB、图片 ≤10MB（可配）。

## 1. 实现

### 1.1 标记解析与安全边界（`src/media.ts`）

- `extractMediaMarkers(text)`：剥除 `^\s*MEDIA:(\S.*?)\s*$` 行，返回正文 + paths；
- `resolveMedia(path, limits)`：
  - 必须绝对路径；
  - `realpath` 后前缀比对 `mediaRoots`（默认 `[会话 cwd]`）；
  - 必须存在且是普通文件；
  - 按扩展名判断图片，分别套 `maxSendImageBytes` / `maxSendFileBytes`；
  - 失败返回 `{ok:false, name, reason}`。

### 1.2 发送（bridge）

- `#settleTurn` 先解析终稿正文：
  - `sendMedia !== false` 时剥除 MEDIA 行；
  - 校验每个路径，合法项写 `📎 name × 1`，失败项写
    `📎 name：未发送（原因）`；
  - 用这段正文 patch 终稿卡（先卡、后文件）。
- `#sendOutboundMedia` 对每个合法文件单独：
  - 图片 → `uploadImage` → `reply({kind:'image', imageKey}, {threadId})`；
  - 其他 → `uploadFile(name, bytes)` → `reply({kind:'file', fileKey, fileName}, {threadId})`；
  - 单个失败只 `warn`（`media send failed for <name>`），继续后续文件，不影响主流程。
- `sendMedia=false`：不提取、不发送，标记原样留在正文。

### 1.3 transport

- `FeishuApi`/`Transport` 新增 `uploadFile`、`uploadImage`；
- `LarkFeishuApi` 调 `im.v1.file.create` / `im.v1.image.create`；
- `ReplyPayload` 增加 `file` / `image` 两种，`ReliableTransport.reply` 生成
  `msg_type=file|image` 与对应 JSON content，仍走 reply/reply_in_thread。

### 1.4 配置与版本

`sendMedia=true`、`maxSendFileBytes=30MiB`、`maxSendImageBytes=10MiB`、
`mediaRoots=[]`（仅会话 cwd）；README 英/中新增「让 agent 发文件给你」一节与四行配置。
版本 0.6.0。

## 2. 测试

原有 291 例保留，新增 8 例，共 **299** 全绿：

- 两个 MEDIA 行 → 正文剥除、卡片尾注 `📎 … × 1`、图片/文件走不同 upload 并各自 reply；
- 相对路径 / 不存在 / 越界 → 跳过 + 卡片原因，零上传；
- 超限 → 不调用上传，卡片注明；
- 单个上传失败 → 其余照发 + warn；
- `sendMedia=false` → 零上传，MEDIA 保留；
- extractMediaMarkers / resolveMedia 单测；
- 配置默认/覆盖。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 图片 | 让 agent 生成 png 并写 `MEDIA:`，图片出现在当前话题 |
| 2 | 文件 | pdf/zip 等作为文件消息出现在话题内 |
| 3 | 卡片 | 终稿卡正文无 MEDIA 行，尾部有 `📎 name × 1` |
| 4 | 越界/不存在 | 卡片写 `📎 name：未发送（原因）`，无上传 |
| 5 | 超限 | 超过 30MB/10MB 不发送并注明 |
| 6 | 关闭 | `sendMedia=false` 时标记保留、不发送 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.6.0。
- mediaRoots 为空时只允许会话 cwd；相对路径一律拒绝。
- 上传/发送失败只 warn，不重试、不影响其他文件与回合。
- `docs/DESIGN.md` 未触碰；profile 未改。
