# 第三十六刀（P0）：交互答者改到插件根 ctx 注册

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机证据与根因

- 0.2.2 日志有 `interactive: attached to agent scope (total=1)`，说明 per-agent 注册执行了；
- 但同一会话 turn 16 调 `ask_user_question` 时没有任何 `interactive: question request`；
- 会话卡住、卡片不弹。

对照 dsh 自带 ACP 桥（`packages/acp/acp/lib/index.js:1115`）：
它在**插件自己的根 ctx** 上 `ctx.on("approval/request", …)`，再用 `request.agent` 判归属。
我们此前的监听装在 `setup(agentCtx)` 的未发布 agent 作用域上，派发时到不了，因此请求
永远进不了答者。

## 1. 改动

### 1.1 注册位置

- 删除 `InteractiveRuntime.attach(agentCtx, …)` 与 bridge 里所有 per-agent 调用；
- 新增 `InteractiveRuntime.registerRoot(rootCtx, { ownsSession, contextFor })`：
  - 在插件根 ctx 上只注册一次：
    `rootCtx.on('approval/request', …)` / `rootCtx.on('user-questions/request', …)`
  - Bridge 构造函数在拿到 `rootCtx` 时调用一次；`index.ts` 传入插件根 `ctx`。
- 启动日志：`interactive: answerers registered (root scope)`。

### 1.2 归属过滤

- 每次派发从 `request.agent.session.id` 取 sessionId；
- `ownsSession(sessionId)`（bridge 用 session→scope 映射）为 false 或取不到 id：
  - 日志 `interactive: <kind> request agent=<前12> not ours, delegated`
  - **直接 `return next()`**，零卡片、零 pending，不抢别人的请求；
- 属于我们：
  - 日志 `interactive: <kind> request agent=<前12> claimed`
  - 用 `contextFor(sessionId)` 取 chatId/scopeKey/ownerOpenId，进入原发卡逻辑；
  - 其余 pending、点击、超时逻辑完全不变。

### 1.3 清理

- 删除 `isAgentScope` / `AgentScopeLike` / `attachedCount` 等不再使用的 per-agent 代码；
- 根 ctx 非法时仍有一条 `interactive: register skipped (not an event scope: …)`（warn），不留死代码。

## 2. 测试

- 原有 259 例保留，新增/改写后共 **261** 全绿：
  - 根 ctx 收到 request 且 agent 属于我们 → 发卡、等待、点击 resolve；
  - agent 不属于我们 → 调 `next()` 一次、零卡片、零 pending；
  - 两个不同会话并发请求 → 两张卡、两个 pending、各自独立 resolve；
  - bridge 根注册一次、agent setup 上不再有 answerer 监听；
  - 保留 previous 诊断日志断言（root 注册成功/非法跳过）。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 启动注册 | 日志出现 `interactive: answerers registered (root scope)` |
| 2 | 请求到达 | 发 `ask_user_question` 后日志出现 `interactive: question request agent=… claimed` |
| 3 | 卡片 | 同一话题收到选项卡片（或文本提示卡） |
| 4 | 点击 | 点选项后日志出现 `card action …`，同一张卡变「已选择：…」 |
| 5 | 非本会话 | 其他 agent 的审批/问题请求日志为 `not ours, delegated`，不被抢答 |
| 6 | 超时 | 不点 300s 后日志 `question timed out after 300000ms`，请求 reject |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.2.3 后验证。
- 归属判断依赖 bridge 的 session→scope 映射；会话在 bridge 内创建/恢复后即登记。
- 根 ctx 注册在 Bridge 构造时执行一次，后续仅通过 request 自带 agent 路由，不再逐 agent 注册。
- `docs/DESIGN.md` 未触碰；profile 未改。
