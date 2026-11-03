# 第五十六刀：`/usage` 改从会话日志聚合

状态：**代码与单测完成；需同步并重启后真机验证。**
未改 dsh 源码/profile、未重启。

## 0. 真机 bug

`/usage` 回「暂无用量数据」，但会话日志里有 96 条 usage 事件。
根因：此前只在内存 `StatusTracker` 累加 `assistant/message`；网关重启后 tracker 从空开始，
而 `/usage` 是自有命令、不跑回合 → 永远看不到历史。

## 1. 改动

- 新增 `src/usage.ts`：
  - `aggregateUsage(events)`：只取 `assistant/message`，按 `data.turn` 分组求和，
    字段 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/totalTokens`；
    `totalTokens` 优先，缺失用字段相加；字段缺失按 0。
  - 输出 turn 降序（最新在前），`total` 全会话累加。
  - `renderUsageReport` 三行：
    ```
    本回合：输入 … · 输出 … · 缓存命中 … · 合计 …
    上回合：…
    会话合计：…
    ```
    空 → `会话里还没有用量记录`。
- `/usage` 改为读会话日志：
  - Bridge 新增 `usageProvider(sessionId)`；index 用
    `ctx.get('sessionQuery').readSession(sessionId).events`（与 `/export` 同一条服务路）；
  - 取不到 sessionId → `读不到会话日志（当前没有会话）`；
  - 服务缺失/返回 undefined → `读不到会话日志（sessionQuery 服务不可用）`；
  - readSession 抛错 → `读不到会话日志（<原因>）`；
  - 三种降级分开，不再混成「暂无」。
- 内存 `StatusTracker` 的 usage 继续保留给过程卡，不影响 `/usage`。
- 版本 0.10.3。

## 2. 测试

原有 377 例保留，新增/更新后共 **388** 全绿：

- 单 turn 多条 usage 求和；
- 多 turn：本回合/上回合/合计；
- 缺 cacheWrite/cacheRead 字段；
- 空日志 → 还没有用量记录；
- readSession 抛错 → 读不到会话日志并带原因；
- sessionQuery 缺失 → 读不到会话日志；
- 大数不溢出、0 值正常显示；
- cacheWrite 计入合计不单独显示；totalTokens 优先。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 历史用量 | 重启后直接 `/usage`，能看到旧会话 96 条 usage 的汇总 |
| 2 | 三行 | 本回合/上回合/会话合计正确 |
| 3 | 空日志 | 新会话无 usage → 「会话里还没有用量记录」 |
| 4 | 读不到 | sessionQuery 不可用/抛错 → 「读不到会话日志（原因）」 |
| 5 | 大数 | cacheRead 十几万量级正常显示 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需同步 dist 并重启。
- 数据源为 `sessionQuery.readSession`；与 `/export` 一致，不另读磁盘。
- 过程卡 tracker 逻辑未改。
- `docs/DESIGN.md` 未触碰；profile 未改。
