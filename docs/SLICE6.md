# 第六刀：会话键改为 Hermes 三分规则（普通群按人隔离）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh` 数据。

## 0. 背景

Hermes 的 `gateway/session.py::build_session_key` 规则（已核实）：

| 场景 | Hermes 默认 | scope key |
|:--|:--|:--|
| 私聊 | 按 chat | `chatId`（无 chatId 回落 sender） |
| 普通群（无话题） | `group_sessions_per_user=True` | `chatId + "\u0000" + sender_open_id`（**按人隔离**） |
| 话题（有 thread） | `thread_sessions_per_user=False` | `chatId + "\u0000" + thread_id`（**多人共享**） |

caduceus 之前 p2p 与普通群都回落 `chatId`，普通群多人共享一条上下文，与 Hermes 不一致。本刀对齐。

## 1. 改动

### 1.1 `scopeKey` 新签名与三分规则

`src/session-key.ts`：

```ts
scopeKey(chatType, chatId, threadId, senderOpenId): string
```

- `chatType === 'p2p'` → `chatId`（空时回落 `senderOpenId`）；
- 有 `threadId`（群内话题）→ `chatId + "\u0000" + threadId`（忽略 sender，多人共享）；
- 普通群（无 thread）→ `chatId + "\u0000" + senderOpenId`（按人隔离；空 sender 退化为 `chatId`，避免奇怪尾分隔）。
- 所有调用点同步传参：`Bridge#handleInbound` 的串行队列键与 `Bridge#stateFor` 的 state 键；`InboundMessage` 已带 `chatType` / `senderOpenId`（上一刀归一化时已有，无需补字段）。

### 1.2 session-map 升 version 4

- `SESSION_MAP_VERSION = 4`；`SessionMapV4` 与 v3 同形（`{version, entries, cwd}`）。
- `load()` 兼容 **v4 / v3 / v2 / v1**（含无 version 的旧扁平 map）：
  - v4：正常读；
  - **v3：键原样保留**（视为该群/话题的旧共享会话，**不批量改写、不重新映射**），下次 `persist()` 写成 v4；
  - v2/v1：沿用既有迁移逻辑，旧键原样保留。
- `load()` 不写盘；损坏/未知版本仍只 warn 不抛错。
- 新消息只落**新规则计算出的键**：普通群用户会得到自己的新 session；旧共享条目留在文件里不被销毁。

### 1.3 `/sessions` 的作用域

- 仍然只列当前 `scopeKey` 的会话（state 只持本 scope 的 current/previous），因此自然满足「不跨话题、不跨人」；普通群不同用户之间互相看不到对方的会话行。
- 旧 v3 共享条目不会出现在 `/sessions` 中（不属于新 scope 键）；数据仍保留在 session-map 文件里。

## 2. 测试

- 原有 126 例全部保留（调用 `scopeKey` 的测试按新签名更新参数；断言意图不变），新增 6 例，共 **132 例全绿**。
- 新增（关键三条 + 纯函数 + 旧数据）：
  - `Hermes 键：私聊同 chat 两个 sender → 同键、同一会话`
  - `Hermes 键：普通群两个 sender → 不同键、不同 sessionId（按人隔离）`
  - `Hermes 键：群内话题两个 sender → 同键、共享同一会话`
  - `scopeKey: p2p 按 chatId（无 chatId 回落 sender）`
  - `scopeKey: 普通群按 chatId + sender_open_id 隔离（同群两人不同键）`
  - `scopeKey: 群内话题按 chatId + threadId，多人共享（忽略 sender）`
  - `SessionStore: v3 旧条目原样保留，load 不改写，新键落 v4 且不批量改写`
  - `v3 旧共享条目原样保留，新消息落 per-user 新键（v4）`
- 全部注入式（假 transport / 假 agents / mkdtemp），不碰真飞书与真 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 普通群按人隔离（核心） | 同群两个不同用户分别 @ 机器人发消息：session-map 出现两个 `chatId\0ou_...` 键、两个 sessionId；两人上下文互不影响 |
| 2 | 话题多人共享 | 同群同一话题内两个用户分别 @ 机器人：只出现一个 `chatId\0omt_...` 键、同一 sessionId，二人看到同一上下文 |
| 3 | 私聊 | 私聊仍按 chatId 一条会话，不受 sender 影响 |
| 4 | 旧 v3 数据 | 升级重启后 session-map `version` 变 4；旧共享键（如普通群的 `chatId` 键）仍在文件中且 sessionId 未变；普通群用户的首条新消息新建独立会话，不复用旧共享会话 |
| 5 | 旧会话可见性 | `/sessions` 只显示当前 scope 的会话；旧共享会话不会出现在任何新 scope 列表里（文件里保留） |
| 6 | 门禁不变 | 群聊（含话题）仍必须 @；p2p 免 @；机器人/应用消息仍被丢弃 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 升级后普通群的历史共享会话不会自动拆分给各用户，也不会删除；需要旧上下文时只能靠 sessionId 手动恢复（当前 UI 未提供入口）。
