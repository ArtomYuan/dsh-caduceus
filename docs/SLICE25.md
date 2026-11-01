# 第二十五刀：工具数只认模型实际收到的 `request/header.tools`

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 问题

真机：`selfcheck: FAIL tools:count(fail): 自检 2 ≠ 实际 37`。
即使等到首次 `step/start`，agent 作用域里的 tools 服务仍只看得见 2 个；而
`request/header.tools` 是 37。错的是**计数源**，不是时机：tools 服务对 agent 作用域的可见性
不对，永远少算。

## 1. 改动

### 1.1 删除 tools 服务计数

- `SelfCheckOptions` 删除 `toolCount` / `requestHeaderTools`；不再调用 tools 服务做数量统计
  （阶段 A 的 `tools:service` 存在性检查保留）。
- 删除双源对账逻辑（不再有第二个源）。

### 1.2 只认首条 `request/header`

- Bridge 监听 `request/header` 事件：取 `event.data.header.tools` 长度，按 session 只判一次
  （`#toolsCheckedSessions`）。
- `SelfChecker.checkTools(toolCount)`：
  - length > 0 → `tools:count ok (tools=N)`；
  - length = 0 → `tools:count fail`，FAIL 行 `tools:count(fail): request/header.tools 为空`；
  - 未收到 request/header → 保持 `pending`（skip），不 fail。
- 自检行在首条 request/header 后打：
  `selfcheck: ok preset=<id> tools=<header.tools.length> persona=<bytes>B`。

### 1.3 `/selfcheck`

- 明细里 `tools:count` 有已知值显示 `ok tools=N`；没有则 `pending：等待首条 request/header`（skip）。
- `runAll` 会用最近一次已知的 header 工具数重跑，未收到时保持 pending。

## 2. 测试

- 原有 221 例全部保留（旧“服务计数/双源对账/step 计数”用例改写为 header 语义，不是删除），
  新增/改写后共 **223 例全绿**：
  - `首条 request/header 带 37 个工具 → tools=37，状态 ok`（日志出现 tools=37）；
  - `request/header.tools 为空数组 → tools:count fail`（FAIL 行含 `request/header.tools 为空`）；
  - `未收到 request/header → pending，不 fail`（`/status` 不出现 ✗，无 warn）；
  - `不再依赖 tools 服务计数：SelfCheckOptions 无 toolCount 依赖也能出结果`；
  - Bridge：`每会话只在首条 request/header 判一次`（第二次 header 99 不再覆盖 37）。
- 全部注入式（假事件/假 presets），不碰真实 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 工具数正确 | 首轮对话后：`selfcheck: ok preset=standard tools=37 persona=…B`，与 request/header 一致 |
| 2 | 不再双源告警 | 不再出现 `自检 2 ≠ 实际 37` |
| 3 | 首 header 前 pending | 会话已建但尚未请求时：`/status` 显示 `自检 ○（待首会话验证）`，不 FAIL |
| 4 | 空工具面 | 人为让 request header 无工具：`tools:count(fail): request/header.tools 为空` |
| 5 | 只判一次 | 后续 request/header 变化不再改判（每会话首条为准） |
| 6 | preset 失败 | preset 未挂载仍 `preset:applied(fail)`，与工具数独立 |
| 7 | `/selfcheck` | 明细 tools 项显示 `ok tools=37` 或 pending，不显示 tools 服务计数 |
| 8 | 回归 | 启动、`/status`、卡片、消息投递均不受影响 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 只取每会话首条 request/header；后续 request header 变化不重新判定（按需求）。
- 事件缺失/形状异常时按 pending 处理，不 fail。
- 工具服务仍用于阶段 A 的“服务是否存在”检查，但不再用于计数。
