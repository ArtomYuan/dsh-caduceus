# 第三十三刀（P0）：审批卡片 + 选项卡片（可交互 + 按钮回调）

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 接口复核

- 审批入口是 `approval/request` waterfall（agent-scoped），返回
  `allowed-once | rejected | cancelled | unavailable`；`approval/asked|decided` 不是入口。
- 选项入口是 `user-questions/request` waterfall（agent-scoped），返回
  `{ answers: [{ id, selected, custom? }] }`。
- 飞书 SDK 的 `card.action.trigger` 可拿到 `operator.open_id`、`open_message_id`、
  `context.open_chat_id` 与 `action.value`；传输层此前只注册了消息事件。

## 1. 实现

### 1.1 transport

- `lark.ts` 注册 `card.action.trigger`；新增 `normalizeCardAction()`（`normalize.ts`）归一化为
  `{ operatorOpenId, messageId, chatId, value }`，缺 operator/message/value 返回 undefined。
- `Transport`/`FeishuApi` 新增可选 `onCardAction(handler)`；`ReliableTransport` 透传；
  `FakeTransport.deliverCardAction()` 作为测试 seam。

### 1.2 interactive 模块

- `pending.ts`：id → pending entry（kind/scope/chat/owner/session/cardMessageId/createdAt/
  resolve/reject/cleanup/meta），`randomUUID` 生成 id，支持超时清理。
- `approval.ts`：注册监听 → 发「审批请求 · <toolName>」卡（reason 缺失显示“（无说明）”，
  按钮“允许一次/拒绝”，value 含 `{kind,id,sessionId,choice}`）→ 等待 → 返回 dsh 仅允许的四种结果。
  发卡失败 → ERROR + `cancelled`；超时/abort → 补丁“已过期/已取消” + `cancelled`。
- `question.ts`：单问题且单选 ≤4 选项 → 每个选项一个按钮；否则一张文本卡 + “本版暂不支持在卡片内输入文字，
  请直接回复文本作答”提示（本版无自由文本输入）。超时/abort → reject。
- `runtime.ts`：CLI 点击路由；按 id 找 pending → 校验 `operatorOpenId === ownerOpenId`
  （不符只 warn、不 resolve、不 patch）→ 先 patch 同一张卡为终态（去按钮）→ resolve。
- 卡片终态：`已允许` / `已拒绝` / `已选择：<label>` / `已过期` / `已取消`。

### 1.3 接线与配置

- `#createAgent` 与两条 resume 路径（mapped session 的 `#resolveAgent`、`/resume` 的
  `#switchSession`）的 `setup(agentCtx)` 里 `InteractiveRuntime.attach()`；
  监听只装在我们自己 agent 的 scope 上。
- 配置新增：`approvalCard`（true）、`questionCard`（true）、`interactiveTimeoutMs`（300000）。
  关闭时审批直返 `unavailable`、选项直接 reject，均不发卡。
- 版本 0.2.0；README 配置表同步新增三项。

## 2. 测试

- 新增 `test/interactive.test.ts` 11 例：
  - 审批：允许 → allowed-once + 终态卡；拒绝 → rejected；超时 → cancelled；
    发卡失败 → cancelled + ERROR；越权点击不 resolve/不 patch + warn；patch 失败仍 resolve + warn；
  - 选项：3 选项 → 3 按钮 + 点击第 2 个返回对应 label；超时 reject；两个并发 id 独立；
    多问题/超 4 选项 → 纯文本无按钮；配置关闭不发卡。
- 新增 transport/config/bridge 各 1 例：卡片事件归一化、配置默认值、create/resume 监听注册。
- 原有 236 例全部保留；总数 **250**，全绿。

## 3. 真机待确认

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 审批卡出现 | 触发需要审批的工具调用，飞书收到「审批请求 · <tool>」，允许一次后工具继续 |
| 2 | 审批拒绝/超时 | 拒绝后调用返回 rejected；不点 5 分钟后卡片变「已过期」并 cancelled |
| 3 | 选项按钮 | `ask_user_question` 单问题 3 选项，卡片出现 3 按钮，点第 2 个返回对应 label |
| 4 | 选项文本卡 | 多问题/超 4 选项时无按钮并提示回复文本（本版不支持输入） |
| 5 | 越权 | 非 owner 点击按钮：无反应，日志有 `non-owner` warn |
| 6 | 配置关闭 | `approvalCard/questionCard=false` 时不出卡，审批 unavailable、选项 reject |
| 7 | 长连接 | 日志应出现 `feishu long connection started`；卡片回调依赖 `card.action.trigger` |

## 4. 约束与遗留

- 未执行 npm publish、未安装、未重启；真机卡片回调需要宿主重启后验证。
- 选项自由文本输入本版未实现（按需求只做按钮/提示）。
- 交互卡发到会话 chat（不强制 thread）；卡片 message_id 用于原地 patch 终态。
- 旧 `docs/DESIGN.md` 的宿主修订未触碰。
