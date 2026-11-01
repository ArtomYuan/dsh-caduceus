# 第二十二刀：启动自检（把静默降级变成可见状态）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 背景

连续三个同型 bug（sessionTitle / agentPresets / 状态卡）都是「服务拿不到就静默降级，只写一行
warn」。最新一例：agent 零工具、无人格、无指令，跑了几周没人发现。

## 1. 改动

### 1.1 自检模块 `src/selfcheck.ts`

每项结果 `ok | fail | skip`；API 拿不到/异常 → `skip`（带原因），**不假报 fail**，也绝不抛到启动。

**阶段 A（ready 后非阻塞执行，`void selfCheck.runStageA()`）**

1. `preset:service` — `ctx.get('agentPresets')` 可取；取不到 = fail（服务未注册）；
2. `instructions:block` — `<DSH_HOME>/AGENTS.md` 存在且恰好一对 soul 标记；缺失/多对/损坏 = fail；
3. `persona:fresh` — 标记块正文与 SOUL 源（`<DSH_HOME>/SOUL.md` → `<DSH_AGENTS_HOME>/SOUL.md`）
   规范化后一致；不一致 = fail（提示 `/persona sync` 或自动同步）；SOUL 缺失 = skip；
4. `tools:service` — `ctx.get('tools')` 可取；取不到 = fail。

**阶段 B（每次 create/resume 成功后）**

5. `preset:applied` — `agentPresets.composedPreset(agentCtx)` 非空；空 = fail（后果：agent 无工具无人格）；
6. `tools:count` — 该 agent 的 `tools.schemas()` 数量 > 0；0 = fail；接口不可用 = skip。

- 阶段 B 在每次 create/resume 后重跑；失败/状态变化的日志由 `SelfChecker` 去重，连续两次相同
  create 不会重复刷屏。
- 捕获 agentCtx：create 的 setup 与 resume 的 setup 都记录 scoped ctx；已有 preset 的 resume 也
  传 setup 只为捕获（不 mount）。
- `src/index.ts` 创建 `SelfChecker`（lazy `ctx.get('agentPresets')/('tools')`、agentCtx 工具计数），
  ready 后立即 `void runStageA()`，不阻塞启动；传给 Bridge。

### 1.2 日志

- 全 ok（A+B 全 ok）：`selfcheck: ok preset=<id> tools=<n> persona=<bytes>B`
- 任一 fail（一行，带后果）：`selfcheck: FAIL preset:applied(fail): agent 无工具无人格, ...`
- 去重：FAIL 只在失败项集合变化时打；ok 只在全 ok 且内容变化时打。

### 1.3 `/status` 与 `/selfcheck`

- `/status` 首行：`自检 ✓` / `自检 ✗ preset:applied, tools:count` / `自检 …`（阶段未齐）。
- 新增 `/selfcheck` 命令：立即重跑两阶段并按行输出
  `id: ok|fail|skip — detail`（阶段 B 无 agent 上下文时对应项 skip）。
- README 命令表、helpText、smoke 命令清单同步更新。

## 2. 测试

- 原有 207 例全部保留，新增 10 例，共 **217 例全绿**：
  - 阶段 A 全过 + 阶段 B 全过 → 一行 ok 日志；
  - 指令块缺失 / 多对 / 人格不一致 → 对应 fail，不抛错；
  - agentPresets / tools 服务缺失 → 对应 service fail（不是 skip）；
  - composedPreset 为空 → preset:applied fail，`/status` 显示 ✗；
  - 工具数 0 → tools:count fail，连续两次同 fail 只 warn 一次；
  - 全 ok 连续两次只打一次 ok；fail→ok 才再打；
  - 阶段 B 接口未接线 → skip，`自检 …`；
  - `/status` 首行自检 ✓；`/selfcheck` 输出六项明细；
  - `/selfcheck` 解析与参数校验。
- 全部注入式（mkdtemp env、假服务/假 presets/假 agents），不碰真实 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 启动 ok 行 | 重启日志一行 `selfcheck: ok preset=standard tools=N persona=NB` |
| 2 | 指令/人格 | 破坏或移除 `$DSH_HOME/AGENTS.md` 人格块后重启：日志 `selfcheck: FAIL instructions:block(fail): ...` |
| 3 | 人格新鲜 | 改 SOUL 不 sync 重启：`persona:fresh(fail)`，提示发 `/persona sync` |
| 4 | 服务缺失 | 临时禁用 preset/tools 服务：对应 `preset:service`/`tools:service` fail |
| 5 | 阶段 B | 新会话后 `/status` 显示 `自检 ✓`；若 preset 未挂载显示 `自检 ✗ preset:applied` |
| 6 | `/selfcheck` | 手动执行：六项明细，一项一行；阶段 B 无会话时 skip |
| 7 | 不阻塞 | 自检任何失败/异常都不影响 gateway ready 与飞书长连接启动 |
| 8 | 防刷屏 | 连续两轮对话：失败/成功日志不重复刷；状态变化才再打 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 阶段 A 的文件检查以当前进程环境（`DSH_HOME`/`DSH_AGENTS_HOME`）为准；测试全部 mkdtemp。
- 阶段 B 工具数依赖 `agentCtx.get('tools').schemas()`；若 API 变化/不可用会降级为 skip。
- 自检只观测/报告，不自动修复；修复仍走 `/persona sync`、preset 配置、依赖安装等既有路径。
