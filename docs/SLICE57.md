# 第五十七刀：停止文案跟随 dsh + 卡片性能/用量指标

状态：**代码与单测完成；需同步并重启后真机验证。**
未改 dsh 源码/profile、未重启。

## 1. 停止文案（不杀后台）

dsh 的停止只 cancel 回合，后台任务（如 `sleep 60`）仍会跑完并把结果注入。
本插件不实现 kill；文案改为诚实版本：

- 停止按钮回调后卡片、`/stop` 命令回复统一：
  `已停止当前回合。后台任务仍在运行，完成后结果会回来。`
- cancel 路径仍是同一个 `#cancelCurrentTurn`（`agent.cancel({kind:'user'})`）。

## 2. 卡片指标

新增配置 `metrics: 'off' | 'compact' | 'detailed'`，默认 `compact`；
数据全部从会话日志事件聚合（`src/metrics.ts`），不依赖内存 tracker。

- 轮数 = 最大 `data.turn`；步数 = `step/start` 累计；
- tok/s = 本回合输出 token / 本回合耗时（turn/start→turn/end 或最后事件），<1s 不显示；
- 累计 tok = 所有 assistant/message 的 totalTokens 之和；`>1e6 → 7.9M`，`>1e3 → 1.6k`；
- 缓存命中 = cacheRead / (cacheRead + input)，0 分母不显示；
- 上下文（仅 detailed）= 最近 request/context.contextWindow 与上一回合 prompt token 之比，
  任一缺失不显示。
- 输出行例：
  - compact：`4 轮 · 12 步 · 156 tok/s · 7.9M tok · 缓存 99%`
  - detailed：`… · 缓存 99% · 上下文 18%`
- 落点：过程卡底部 + `/usage` 末尾同一行。
- Bridge 维护本进程已见事件的 `logEvents`（上限 5000）供过程卡用；`/usage` 用
  `sessionQuery.readSession` 的完整日志。

## 3. 版本

0.10.4；README 增加 `metrics` 配置行。

## 4. 测试

原有 388 例保留，新增 14 例，共 **402** 全绿：

- metrics 纯逻辑：数字格式、轮/步/token/缓存、tok/s 缺失、缓存 0/100、上下文、detailed 行；
- bridge：compact 行、off 不显示、detailed 上下文、缺 contextWindow 不显示、
  `/stop` 新文案、停止卡片新文案（旧用例更新）；
- 配置 metrics 默认/覆盖。

## 5. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | compact | 过程卡底部出现 `N 轮 · M 步 · … tok/s · … tok · 缓存 …%` |
| 2 | detailed | 末尾多 `· 上下文 N%`；无 contextWindow 时不显示 |
| 3 | off | 指标行不出现 |
| 4 | /usage | 三行用量后追加同一摘要行 |
| 5 | 停止 | 卡片与 `/stop` 都是「后台任务仍在运行…」的新文案 |
| 6 | 大数/0 | 7.9M、1.6k、0% 等情况正常 |

## 6. 约束与遗留

- 指标来自日志事件，不依赖 tracker；进程卡只持有本进程所见事件，重启后新回合指标从新事件累计。
- 不实现 kill 后台任务，文案明确提示结果会回来。
- `docs/DESIGN.md` 未触碰；profile 未改。
