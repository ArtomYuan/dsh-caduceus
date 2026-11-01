# 第四十一刀（P0）：提及占位符还原 + bot 身份未知 fail-closed

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机问题

1. 正文里的 `@_user_N` 原样进了 agent prompt（伊冯看到的就是这个）：
   旧 normalize 只删 `<at>…</at>` 与**开头**的占位符。
2. `gate.ts` 在 `botOpenId` 未知且消息带 mention 时直接 accept（fail-open），
   任意 @ 都能穿透群门禁。

## 1. 改动

### 1.1 提及还原（`normalize.ts`）

- `message.mentions[]` 读取 `key`、`name`、`id.open_id`。
- 先把 `<at …>inner</at>` 还原为 `@inner`（而不是整段删除）。
- **机器人自己**（`id.open_id === botOpenId`）的提及：从正文里删除
  `key` 与 `@name`（开头、正文都删）。
- 其余 mention：`key` → `@<name>` 全文替换（长 key 优先，避免
  `@_user_1` 误伤 `@_user_10`）。
- 无 mentions 元数据时保持旧行为（删 `<at>`、剥前导占位符）。
- Lark 归一化时传入 `this.botOpenId`，所以真机事件能识别“@自己”。

### 1.2 群门禁 fail-closed（`gate.ts`）

- 新增 drop reason `bot-identity-unknown`。
- botOpenId 未知：
  - 无 mention → `no-mention`（与旧行为一致）；
  - 有 mention → 默认 `{accept:false, reason:'bot-identity-unknown'}`；
  - 显式 `gateRequireBotIdentity:false` 才退回旧的 `mentioned` 放行。
- Bridge：
  - 群消息到来且 bot id 未知时，先 `transport.refreshBotOpenId()` 重试一次；
    bot/v3/info 成功后恢复正常判定；
  - `bot-identity-unknown` 的 ERROR **每进程只打一次**：
    `gate: bot identity unknown; group @ messages are rejected until resolved`。
- 新配置 `gateRequireBotIdentity`（默认 true）；README 英/中已加行。
- 版本 0.4.1。

## 2. 测试

原有 278 例保留，新增/更新后共 **281** 全绿：

- 正文 `@_user_2 你好` + `{key:'@_user_2',name:'张三'}` → `@张三 你好`；
- 机器人自己的开头/正文提及被剔除；混合提及留下 `@张三`；
- 无 mentions 元数据仍按旧行为剥前导占位符；
- botOpenId 未知 + mention → `bot-identity-unknown` reject，零 agent；
- ERROR 只一次；下一条消息身份恢复后 accept；
- 未知 + 无 mention → reject；
- `gateRequireBotIdentity:false` 恢复旧 fail-open；
- 配置默认 true / 显式 false。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 正文提及 | 用户发“@张三 你好”，agent prompt 里是 `@张三 你好`，不是 `@_user_2` |
| 2 | @机器人 | 开头/正文 @机器人 不进入 prompt；命令仍可执行 |
| 3 | 身份未知 | bot/v3/info 失败时群 @ 消息被拒，日志一行 ERROR（不刷屏） |
| 4 | 身份恢复 | 之后 bot id 拿到，下一条群 @ 消息正常进入 |
| 5 | 配置 | `gateRequireBotIdentity:false` 才恢复旧放行行为 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.4.1。
- 只还原 mentions[] 里有元数据的占位符；无元数据时仍是旧行为。
- bot 身份重试发生在每条 bot 未知的群消息上，成功后不再重试。
- `docs/DESIGN.md` 未触碰；profile 未改。
