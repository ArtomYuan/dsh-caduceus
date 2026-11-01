# 第二十四刀：tools 计数改为首次 step/start（并与实际下发的 request header 校验）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 问题

真机：`selfcheck: ok preset=standard tools=2 persona=1563B`，但同一会话模型实际收到的
`request/header.tools` 长度是 **37**。

原因：阶段 B 在 `create()` 返回后立即计数；`agentPresets.mount()` 里的工具注册是异步的，
此刻只看到 2 个（部分注册），于是把错误数字写进了自检。

## 1. 改动

### 1.1 延迟到首次 `step/start`

- 阶段 B 在 create/resume 后仍检查 `preset:applied`，但 `tools:count` 初始为
  `skip`（detail：`等待首次 step/start 后判定（create 时工具注册未完成）`）。
- `handleSessionEvent` 把 `step/start` 单独拆出：调用 `#maybeSelfCheckTools(session)`，
  每个 session 只判一次（`#toolsCheckedSessions` Set 去重）。

### 1.2 计数来源与一致性

- `SelfChecker.checkTools(agentCtx, session)`：
  1. 优先 `toolCount(agentCtx)`（agent 的 tools 服务快照，`schemas().length`）；
  2. 拿不到时回退 `requestHeaderTools(session)`（首次请求 `request/header.tools` 长度）；
  3. **不得**使用插件自己扫到的部分注册。
- 两者都拿到但不相等 → fail：
  `selfcheck: FAIL tools:count(fail): 自检 N ≠ 实际 M`。
- 有效值为 0 → fail；两个来源都不可用 → skip（不假报 fail）。

### 1.3 日志与状态

- 首次 step 后若一切正常：`selfcheck: ok preset=standard tools=37 persona=1563B`。
- 不一致/为 0 时 FAIL 行；`/status` 对应 `自检 ✗ tools:count`。
- 相同状态继续去重；`/selfcheck` 重跑时会用最近一次 session/agentCtx 重新计数。

## 2. 测试

- 原有 218 例全部保留（阶段 B 立即计数的旧断言改为“skip，等 step”；计数用例改为调用
  `checkTools`），新增 3 例，共 **221 例全绿**：
  - `异步 mount：create 时只见 2 不定案，首次 step/start 后读 37 → tools=37`
    （断言 create 后 tools 仍 skip、无 ok 日志；step 后 tools=37 且日志出现 37）；
  - `tools 快照与 request/header 不一致 → FAIL 行带两个数字`
    （`自检 2 ≠ 实际 37`，`/status` 显示 ✗）；
  - `自检 tools:count 每会话只在首次 step/start 判一次`（两次 step/start 只调用一次）。
- 全部注入式（假 tools/header/agents），不碰真实 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 计数正确 | 重启后首轮对话：`selfcheck: ok preset=standard tools=37 persona=…B`（与 request/header 一致） |
| 2 | 不再 create 时定案 | 首条消息后、模型 step 前：`/status` 显示 `自检 ○（待首会话验证）`（不是 ✓/✗） |
| 3 | step 后转 ✓ | 第一次 step/start 后 `/status` 变 `自检 ✓`，日志出现正确 tools 数 |
| 4 | 不一致报警 | 人为制造 tools 快照与 request header 差异：FAIL 行带两个数字 |
| 5 | 只判一次 | 同会话多次 step/start：不再重复计数/刷日志 |
| 6 | 0 工具 | preset 未挂载导致 0 工具：`tools:count(fail)` |
| 7 | 回退 header | tools 服务快照不可用但 request header 可取：仍能给出正确数（不 skip） |
| 8 | 回归 | 自检不影响启动；`/status`/`/selfcheck`/`/persona` 等既有行为不变 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 只做首次 step/start 判定：如果一个会话第 2 步工具面变化，不重新判定（按需求每会话一次）。
- `request/header.tools` 回退依赖 Session 的 `requestHeader()`；旧 session/API 不可用时降级 skip。
