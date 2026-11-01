# 第二十七刀：自检异常进对话（去重 + 恢复 + 分级日志）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 决定

用户拒绝外部探针：“什么叫推给你？而是在日志和对话才对。”
自检异常不能再只躺在日志里，必须在出问题的会话里看得见。

## 1. 行为

### 1.1 会话内提示

- 自检出现 fail 时，在发生问题的会话发**一条文本**（不是新卡）：
  `⚠ 自检异常 preset:applied — agent 无工具无人格（详情 /doctor）`
- 多个 fail 合并为一条，最多 3 项，其余写 `等 N 项`。
- 发送失败不重试、不阻塞主流程；只记 warn。

### 1.2 去重与恢复

- 以**排序后的 fail 项 id 列表**为签名：
  - 同组 fail 只提示一次；
  - 组合变化（多/少/换项）才再提示；
  - 全部恢复正常 → 发一条 `✓ 自检已恢复`，同一次恢复只发一次；再次失败/恢复会重新提示。
- 状态保存在 Bridge（进程内），发送前先记录签名，避免失败重试。

### 1.3 日志分级

- fail → `logger.error`（不再是 WARN）；
- ok / skip deferred → INFO；
- 恢复 → INFO `selfcheck recovered`。

### 1.4 `/status`

- 首行仍三态：`自检 ✓` / `自检 ○（待首会话验证）` / `自检 ✗ <fail 项>`；
- 有 fail 时追加：`最近异常：<项> @ <相对时间>`（由 SelfChecker 记录最近 fail 时间/项）。

### 1.5 `/doctor`

- 每次运行后记一行 INFO：`doctor: N ok / M fail / K skip`。

### 1.6 ready 阶段延后

- 启动阶段 A 若已 fail，此时没有任何会话可发：**不发**，只记 ERROR；
- 首条有会话的消息进来时（`#processInbound` 开头）补发一次，之后按签名去重。

## 2. 实现要点

- `SelfChecker` 新增 `failureIds()`（排序）、`failureItems()`、`lastFailureAt()`，
  `#recordFailures()` 在每次 report 更新时记录；fail 日志改 ERROR。
- Bridge 新增 `#selfCheckNotifiedSignature` 与 `#maybeNotifySelfCheck(state)`，
  调用点：入站消息开始、stage B 之后、request/header 计数之后、`/selfcheck` 之后。
- 恢复提示只依赖签名从非空变空，不需要额外持久状态。

去重 + 组合变化判定（节选）：

```ts
const fails = checker.failureIds();
const signature = fails.join(',');
if (signature.length > 0) {
  if (signature === this.#selfCheckNotifiedSignature) return;
  this.#selfCheckNotifiedSignature = signature;
  // ...发 ⚠ 自检异常（最多 3 项）
} else {
  if (this.#selfCheckNotifiedSignature === undefined) return;
  this.#selfCheckNotifiedSignature = undefined;
  this.#logger.info('selfcheck recovered');
  await this.#replyText(state, '✓ 自检已恢复');
}
```

ready 阶段延后（节选）：

```ts
// #processInbound 开头：启动 A 段 fail 无会话可发，等这里补发一次
state.lastInboundMessageId = message.messageId;
await this.#maybeNotifySelfCheck(state);
const text = message.text.trim();
```

## 3. 测试

- 原有 230 例全部保留（旧 fail 日志断言从 warn 改 error），新增 3 例，共 **233 例全绿**：
  - `自检 fail 在会话里提示：同组一次、组合变化再发、恢复一次`
    （含 `/status` 的 `最近异常` 行与恢复只发一次）；
  - `ready 阶段自检 fail 不立即发；首个会话消息补发一次`；
  - `自检提示发送失败：不抛错、不重试、日志 warn`；
  - `/doctor` 用例增强断言 `doctor: N ok / M fail / K skip` 日志。
- 全部注入式（假 selfcheck/transport/agents），不碰真实 `~/.dsh`。

## 4. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 失败进对话 | 人为制造自检 fail（如 preset 未挂载），在飞书会话收到 `⚠ 自检异常 …（详情 /doctor）` |
| 2 | 去重 | 同组 fail 继续对话：不再重复提示 |
| 3 | 组合变化 | 新增一个 fail 项：再收到一条（合并 ≤3 项 + 等 N 项） |
| 4 | 恢复 | 修复后：收到 `✓ 自检已恢复` 且只一次；日志 `selfcheck recovered` |
| 5 | 日志分级 | fail 行是 ERROR；ok/skip 是 INFO |
| 6 | /status | 有 fail 时显示 `自检 ✗ …` 且下一行 `最近异常：… @ …` |
| 7 | /doctor | 跑完日志出现 `doctor: N ok / M fail / K skip` |
| 8 | 发送失败 / 启动延后 | 发送异常只 warn、不重试；ready fail 等首个会话才提示 |

## 5. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 提示只发到“当时正在处理的会话”；若多个会话同时活跃，以触发检查的那一个为准。
- 发送失败后签名已记录，不会重试；下次组合变化才再提示（符合“不反复重试”）。
- 恢复提示依赖进程内签名，重启后若仍 fail 会再提示一次（合理）。
