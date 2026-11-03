# 第五十八刀：卡片指标改为会话全量（0.10.5）

状态：**代码与单测完成；需同步并重启后真机验证。**
未改 dsh 源码/profile、未重启。

## 0. 真机 bug

同一会话：卡片 `314.9k tok`，`/usage` `8.8M tok`。
根因：卡片用本进程的 `state.logEvents`（重启后从空开始，上限 5000），
`/usage` 用 sessionQuery 全量日志。用户定调：卡片按会话走，不是 dsh 总览。

## 1. 改动

- 新增每-scope 全量指标缓存：
  `#sessionMetrics: Map<key, {sessionId, metrics, refreshedAtSeq, turn}>`。
- `turn/end` 之后（settle 内）用 `usageProvider`（`sessionQuery.readSession`）重算一次并写缓存；
  一回合一次读盘。
- 切会话（`/new`、`/resume`、`/adopt` 等任何 `#bindSession` 改变 sessionId）时清掉该 scope 缓存
  与 fallback 警告标记。
- 卡片渲染 `#metricsFor`：
  - 有缓存 → 全量指标；
  - 回合进行中（`snapshot.turn > cached.turn`）→ 缓存全量 + 本回合 tracker 增量
    （usage 增量、步数、tok/s），数字单调递增；
  - 缓存为空（刚重启）→ 当场 `usageProvider` 读一次并缓存；
  - 读取失败/无 provider → `metrics fallback: process buffer` warn 一次，
    回退 `logEvents` 且不缓存失败（下次仍可重试）。
- 冷读到的日志若已包含当前回合，`cached.turn` 等于当前 turn，不再重复加增量。
- `/usage` 维持全量日志口径，与卡片一致。
- `state.logEvents` 保留给“最近事件”等，但不再是指标唯一来源。

## 2. 测试

原有 402 例保留，新增 10 例，共 **412** 全绿：

- 重启场景：历史日志 → 卡片显示全量（156.3k tok，而非 0/部分）；
- 回合中：缓存全量 + 增量，数字单调；
- turn/end 后缓存刷新，下一回合沿用全量；
- `/new` 清缓存，新会话小数值；
- readSession 抛错 → 回退 + warn 一次；
- 卡片与 `/usage` 同一日志 totalTokens 一致（1.1k / 合计 1100）；
- 缓存按 scope 隔离；
- 冷读已含当前 turn 不重复加增量；
- 无 provider → fallback + warn；
- 刷新失败只 warn，已有缓存仍可用。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 重启后卡片 | 新进程首张过程卡显示历史全量 token，不是 0/314.9k |
| 2 | 回合中递增 | 一回合内 token 持续增长，不回跳 |
| 3 | turn/end | 下一回合卡片沿用刚刷新的全量 |
| 4 | /new | 新会话从 0/小数值开始，不带上一个会话 |
| 5 | 一致性 | 卡片与 `/usage` 的会话合计相同 |
| 6 | 失败降级 | 日志读不到时 warn `metrics fallback: process buffer`，卡片降级 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需同步 dist 并重启。
- 每回合结束多一次 readSession（用户已接受）。
- 失败不缓存，允许下次重试；指标仍从日志算，不依赖 tracker 长期状态。
- `docs/DESIGN.md` 未触碰；profile 未改。
