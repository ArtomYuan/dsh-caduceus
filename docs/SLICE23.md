# 第二十三刀：修自检假警报（未注册 ≠ 不存在）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 问题

真机输出：
`WARN [caduceus] selfcheck: FAIL preset:service(fail): agentPresets 服务未注册`

但后续日志有 `agentPresets resolved; mounting standard` —— 服务在首条消息时是可用的。
原因：阶段 A 在 `ready` 时立刻检查服务，而服务是**故意惰性解析**的（比插件 apply 晚注册）；
把“还没到时间”当成了“不存在”。

## 1. 改动

### 1.1 阶段 A：服务未注册 → skip

- `preset:service` / `tools:service` 取不到时：
  `skip`，detail = `尚未注册（惰性解析，首次建会话时判定）`，**不再 fail**。
- 阶段 A 的结论只由 `instructions:block`、`persona:fresh` 两个文件检查决定：
  - 文件检查 fail → 阶段 A `fail`；
  - 文件检查 ok + 服务 skip → 阶段 A `degraded`（无 fail）；
  - 全部 ok → `ok`。
- `SelfCheckReport` 增加 `status: ok | degraded | fail`。

### 1.2 阶段 B：真正的运行期判定

- `preset:applied`（`composedPreset` 为空 = fail）与 `tools:count`（0 = fail）保持原样。
- 每次 create/resume 成功后重跑；第一次成功时顺带刷新阶段 A 中此前的服务 skip 项
  （服务此时应已就绪），让状态从 degraded 收敛到 ok。

### 1.3 日志语义

| 场景 | 日志 |
|:--|:--|
| A 文件检查全 ok、服务 skip | `selfcheck: ok (skipped: preset:service, tools:service; deferred to first session)` |
| A 有 fail | `selfcheck: FAIL <items>` |
| B 有 fail | `selfcheck: FAIL preset:applied(fail): agent 无工具无人格`（等） |
| A+B 全 ok | `selfcheck: ok preset=<id> tools=<n> persona=<bytes>B` |
| 重复相同状态 | 不重复打（按 fail 集合 / skip 集合 / ok payload 去重） |

### 1.4 `/status` 三态

- 有 fail → `自检 ✗ <fail 项>`（只列 fail，不列 skip）
- 无 fail、只有 skip（如启动时服务未就绪）→ `自检 ○（待首会话验证）`
- A+B 全 ok（或 B 已验证 ok）→ `自检 ✓`
- `/selfcheck` 明细中 skip 项写清原因（如“尚未注册（惰性解析，首次建会话时判定）”）。

## 2. 测试

- 原有 217 例全部保留（旧“服务缺失 = fail”用例改写为 skip 语义，不是删除），新增 2 例，共
  **218 例全绿**：
  - `阶段 A：服务尚未注册 → skip/degraded，不得含 fail，/status 显示 ○`
    （断言无 fail、skip reason、`自检 ○（待首会话验证）`、启动日志 deferred 行）；
  - `阶段 A 服务 skip 后首会话验证成功：A 服务项刷新，/status 转 ✓`
    （B 成功后 A 的 skip 清零、状态转 ✓，全程无 warn fail）；
  - 既有 B fail / 工具 0 / 日志去重 / `/status` ✗ / `/selfcheck` 六项明细全部保持通过。
- 全部注入式（mkdtemp env、假服务/presets/agents），不碰真实 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 启动不再假警报 | 重启日志应为 `selfcheck: ok (skipped: preset:service, tools:service; deferred to first session)`，不再出现 `preset:service(fail)` |
| 2 | 首会话后收敛 | 第一条消息创建会话后：日志出现 `selfcheck: ok preset=standard tools=N persona=NB`，`/status` 由 ○ 变 ✓ |
| 3 | 真失败仍可见 | 人为让 preset 未挂载：`/status` 显示 `自检 ✗ preset:applied`；工具 0 显示 `自检 ✗ tools:count` |
| 4 | 文件检查 | 破坏 AGENTS.md 人格块 → `instructions:block(fail)`；SOUL 不同步 → `persona:fresh(fail)`（仍为 fail，不受服务 skip 影响） |
| 5 | `/selfcheck` | 启动阶段手动执行：服务项显示 skip + 原因；首会话后显示 ok/具体失败 |
| 6 | 去重 | 连续两轮对话：相同失败/相同 ok 不重复刷日志 |
| 7 | 启动不阻塞 | 自检任何 skip/fail 都不影响 gateway 与飞书长连接启动 |
| 8 | 惰性服务 | 服务晚注册：阶段 A skip，阶段 B 首次 create 能正常 mount 并验证 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 服务 skip 刷新只发生在 B 成功时；若服务持续不可用，`/status` 会一直显示 ○（不是 fail），
  并在 B 的 `preset:applied/tools:count` 中体现真实问题。
- 自检仍只观测/报告，不自动修复。
