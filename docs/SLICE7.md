# 第七刀：旧会话可达性（`/sessions --all`、`/resume` 前缀）+ 群会话开关

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh` 数据。

## 0. 背景

上一刀把会话键改成 Hermes 三分规则后：
- 普通群按人隔离，旧 v3 共享条目仍留在 session-map 里，但 UI 没有入口再看到/恢复它们；
- `/resume` 只能恢复本 scope 的上一条，无法按 id 前缀跨 scope 找回；
- 「整群共享」这个 Hermes 的 `group_sessions_per_user=False` 行为没有配置开关。

本刀补两个口子 + 一个开关。

## 1. 改动

### 1.1 `/sessions --all`

- `/sessions`（无参）：行为不变，只列当前 scopeKey 的 current/previous。
- `/sessions --all`：列出**同一 chatId 下所有 scope** 的会话（session-map 中该 chat 的键：纯 chatId 旧键、`chatId\0omt_…` 话题键、`chatId\0ou_…` 用户键）。
- 行格式：`▸ {标题} · {相对时间} · {sessionId 前 8 位} · {scope 标签}`；当前会话行首 `* `。
- scope 标签：
  - 纯 chatId 键：当前 chat 是 p2p → `私聊`，否则 → `旧会话`；
  - `omt_` 后缀 → `话题 <后缀前 8 位>`；
  - `ou_` 后缀 → `用户 <后缀前 8 位>`；
  - 其他后缀兜底 `旧会话`。
- 无标题显示 `（未命名）`；非当前 scope 若无本进程状态，相对时间显示 `—`。
- 末尾提示：`用 /resume <id 前 8 位> 继续某条会话`。
- 只列本 chatId 的键（精确匹配 `chatId` 或 `chatId\0…`），其他 chat 不会串入。

### 1.2 `/resume` 放宽为完整 id / 不歧义前缀

- `/resume`（无参）：仍恢复本 scope 的上一条（行为不变）。
- `/resume <id|前缀>`：
  - 在该 chatId 的**所有 scope** 的 sessionId 中解析：完全相等优先，否则按 `startsWith(前缀)`；
  - 前缀最短 8 位（完整 id 不受此限）；不足 8 位且无完整匹配时回「前缀至少 8 位」；
  - 唯一命中 → `agents.resume` 成功后，把**当前 scopeKey** 的映射指向该 sessionId（不新建、不 re-mint），并刷新标题/状态卡；
  - 多条命中 → 回歧义提示并列出候选（最多 5 条，`id 前 8 位 · scope 标签`），不切换；
  - 零命中 → 回「没找到匹配的会话」。
- 恢复失败（无持久化日志等）时不改动当前映射，回「恢复会话失败」。

### 1.3 `groupSessionsPerUser` 配置

- `Config` 新增 `groupSessionsPerUser: boolean`（默认 `true`），schemastery 里 `z.boolean().required(false)`。
- `resolveGatewayConfig` 透传到 `BridgeConfig`（默认 true）；`Bridge` 调 `scopeKey(...)` 时作为第五参数：
  - `true`：普通群按 `chatId\0sender_open_id` 隔离（现状，Hermes 默认）；
  - `false`：普通群回退 `chatId`（整群共享）；
  - 话题键不受影响（始终 `chatId\0threadId`）。
- 启动日志新增一行：`groupSessionsPerUser=<bool>`（与 credentials 缺失也无关）。

## 2. 测试

- 原有 132 例全部保留，新增 11 例，共 **143 例全绿**。
- 新增覆盖：
  - `/sessions --all`：混合旧键/话题键/用户键全部列出且标签正确、当前行 `* `、跨 chat 不串、末尾 `/resume` 提示；
  - `/sessions` 无参仍只列当前 scope；
  - `/resume` 唯一前缀切换成功；多条前缀歧义不切换；零命中与 <8 位前缀提示；
  - `groupSessionsPerUser=false` 同群两用户同键共享（`true` 的按人隔离用例保留）；
  - `scopeKey` 开关 false 的纯函数规则；config 默认/显式解析（含凭据环境变量）。
- 全部注入式（假 transport / 假 agents / 假 clock / mkdtemp），不碰真飞书与真 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | `/sessions --all` 标签 | 同群先有旧共享/话题/他人会话后执行：全部行出现，标签分别为「旧会话 / 话题 omt_xxx / 用户 ou_xxx」，当前行有 `* `；其他群会话不出现 |
| 2 | 旧会话可恢复 | 用 `--all` 找到旧会话 id 前 8 位 → `/resume <前8位>`：唯一命中则切过去并沿用原 sessionId（日志可见 resume，不新建） |
| 3 | 前缀歧义 | 若两个 sessionId 前 8 位相同，`/resume` 应回歧义提示并列候选，不切换 |
| 4 | `groupSessionsPerUser=false` | 配置关闭并重启：启动日志出现 `groupSessionsPerUser=false`；同群两用户 @ 机器人后 session-map 只有一个 `chatId` 键、同一 sessionId；话题行为不变 |
| 5 | `groupSessionsPerUser=true` | 启动日志 `groupSessionsPerUser=true`；同群两用户仍各自独立 |
| 6 | 重启兼容 | session-map 仍为 v4；旧键保留；`/sessions --all` 能列出它们；已有 scope 映射不被改写 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- `--all` 中非当前 scope 的相对时间：本进程没有该 scope 状态时显示 `—`（session-map 不持久化时间戳）；如需精确时间，后续可在映射中加 `updatedAt` 字段（会再升版本）。
- 旧 v3 共享会话只能通过 `--all` / `/resume` 找回，不会自动拆分给个人。
