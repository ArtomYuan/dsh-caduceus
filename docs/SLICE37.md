# 第三十七刀（P0）：交互卡走话题 reply，不再发到主聊天

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机证据

```
09:27:16 interactive: question request id=64cf476a… claimed
09:27:16 interactive: question card sending chat=oc_adb23012c
09:27:16 interactive: question card sent messageId=om_x100b6144
09:32:16 interactive: question timed out after 300000ms
```

卡片发出了，但话题列表里没有；父群能看到「问题 · 接下来先做哪个呢？」（已过期），
thread 不是用户所在话题。

根因：
- `index.ts` 的 InteractiveRuntime `sendCard` 直接调 `transport.sendCard(chatId, card)`；
- `reliable.sendCard()` 走 `createMessage`，没有任何 thread 参数；
- 过程卡走的是 `#sendNewCard(state, card)` → `transport.reply(chatId, lastInboundMessageId, …, { threadId })`，
  因此落进话题。

## 1. 改动

- `InteractiveRuntimeOptions.sendCard` 改为
  `(sessionId, card) => Promise<{ messageId, threadId? }>`（不再传 chatId）。
- Bridge 新增 `sendInteractiveCard(sessionId, card)`：
  - 用 `sessionId → scope` 映射找到 live `ScopeState`；
  - 找到 → **直接复用 `#sendNewCard(state, card)`**，与过程卡同一条 reply+thread 路径；
  - 找不到 → warn
    `interactive: no scope state for <sessionId>; falling back to chat send`
    并回退 `transport.sendCard(chatId, card)`（chatId 由 session 映射保留；缺失时为空串）；
  - 返回 messageId + 实际 threadId。
- `updateCard` 不变（按 messageId patch，与话题无关）。
- 日志：`interactive: <kind> card sent messageId=<前12> thread=<前8|->`。
- 私聊 reply 不再显式传 `threadId: undefined`，避免空串/伪 thread（验证断言 threadId 不存在）。
- index 里 runtime 的 sendCard 闭包改调 `bridge.sendInteractiveCard`；bridge 变量先声明后赋值，
  请求发生前已完成初始化。

## 2. 测试

原有 261 例保留，新增 3 例，共 **264** 全绿：

- **话题会话**：交互卡走 `reply`，`threadId=omt_t`，且没有 `sendCard/createMessage`；
  点击后仍 resolve；
- **私聊会话**：reply 的 threadId 为 undefined，replyTo=入站 messageId，点击 resolve；
- **无 state**：回退 `transport.sendCard` 并打 warn。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 话题内可见 | 话题里发 `ask_user_question`，卡片出现在**当前话题**，父群不出现孤立卡 |
| 2 | 发送日志 | `interactive: question card sent messageId=… thread=<8位>`，thread 与入站话题一致 |
| 3 | 私聊 | 私聊触发审批/问题，卡片正常出现，日志 thread=- |
| 4 | 点击/超时 | 点选项后同卡「已选择：…」；不点 300s 后「已过期」 |
| 5 | 无 state | 会话已不在内存时日志出现 fallback warn，不崩 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.2.4 后验证。
- 交互卡发送依赖 bridge 的 live scope；会话刚创建/恢复后即绑定映射。
- 回退路径仅用于内存 state 缺失；chatId 由历史映射保留，映射也没有时为空串（真实发送会失败，但日志可诊断）。
- `docs/DESIGN.md` 未触碰；profile 未改。
