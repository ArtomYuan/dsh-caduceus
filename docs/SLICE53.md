# 第五十三刀：A 组四项（/usage、压缩提示、队友进度、停止按钮）

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 1. `/usage`

- 数据来源：`session/event` 的 `assistant/message.usage`（`TokenUsage`：
  `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` /
  `totalTokens`；计数互斥）。
- `StatusTracker` 累计本回合 / 上回合 / 会话合计；`turn/start` 把本回合滚到上回合。
- 输出：
  ```
  本回合：输入 N · 输出 N · 缓存命中 N · 合计 N
  上回合：…
  会话合计：…
  ```
  无 usage → `暂无用量数据`；缺字段按 0；total 缺省用输入+输出+缓存读写之和。

## 2. 压缩提示

- 订阅 `compaction/start` / `compaction/end`（`StatusTracker` 记录状态）；
- 过程卡加一行：
  - start → `上下文压缩中…`
  - end（无 error）→ `已压缩`；事件带 kept/retained/messages 数字 →
    `已压缩 · 保留 N 条`
  - end（error）→ `上下文压缩失败`
- end 先于 start 不崩。

## 3. 队友进度

- 订阅 `team/member` / `team/task`；
- 过程卡最多一行 `队友 <name>：<状态>`；后到覆盖先到（team/task 用 subject+status）。

## 4. 停止按钮

- 过程卡底部运行中显示「停止」按钮，`value: {action:'caduceus.turn.stop'}`；
- 非运行态/final 卡不显示；
- 点击路由 `InteractiveRuntime.turnStop` → `Bridge.handleStopCardAction`；
- **复用 `/stop` 的取消路径**：抽出 `#cancelCurrentTurn`（`agent.cancel({kind:'user'})`），
  `/stop` 与按钮共用；
- 成功后卡片加 `已请求停止` 并去掉按钮；失败只 warn（`stop card failed: …`）；
- 同一 messageId 1 秒内只接受一次点击。

## 5. 版本与命令

0.10.0；`/usage` 加入自有命令/help/README（15 命令）；smoke 列表同步。

## 6. 测试

原有 347 例保留，新增 14 例，共 **361** 全绿：

- usage：两段汇总含缓存、缺字段、无数据、上回合；
- compaction：start、end 带/不带 kept、error、乱序；
- team：member 一行、task 覆盖不堆叠；
- stop：运行中出现、非运行不出现、点击 cancel 一次 + 卡片已请求停止、
  连点只一次、cancel 抛错只 warn。

## 7. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | /usage | 返回本回合/上回合/合计，缓存命中含 cacheRead |
| 2 | 压缩 | 压缩时过程卡出现「上下文压缩中…」，结束变「已压缩 · 保留 N 条」 |
| 3 | 队友 | 团队任务时过程卡出现一行队友状态，更新覆盖不堆叠 |
| 4 | 停止 | 运行中卡有停止按钮，点击后 agent 被打断、卡显示已请求停止 |
| 5 | 防连点 | 1 秒内连点只取消一次 |
| 6 | 失败 | cancel 失败日志有原因，不崩 |

## 8. 约束与遗留

- 只订阅事件；未改 dsh、profile；未知事件/字段缺失忽略。
- 卡片额外行很短，30KB 上限不变；正文仍按原 tail 裁剪。
- `docs/DESIGN.md` 未触碰；profile 未改。
