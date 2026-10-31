# 第四刀：触发门禁收紧（群聊一律 @） + 标题显示修复 + `/sessions` 行格式

状态：**代码与单测完成；需按宿主流程同步并重启后做第三轮真机确认**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh` 数据。

## 0. 真机反馈

1. **群内话题免 @ 导致双 bot 抢答**（2026-10-31 17:39）：上一刀实现「群内话题若 scopeKey 已绑定会话则免 @」，结果同一话题里两个 bot 都在群里时，用户一句话被两个 agent 同时接。**用户定案：群聊一律要 @，私聊不要 @。**
2. **状态卡一直停在「标题生成中」**：会话日志里已有 `session/title`（fallback + provider 两条），但状态卡没有更新。根因：首次渲染发生在 agent 就绪之前，此时本桥还没绑定该 session，早到的 `session/title` 事件被忽略；之后没有新的事件再次触发渲染。
3. `/sessions` 输出不满足「标题 · 时间 · sessionId 前 8 位」的展示口径。

## 1. 改动

### 1.1 触发门禁：群聊（含话题）一律 @（优先）

- `src/bridge/bridge.ts#accepts`：
  - p2p：直接放行（不需要 @）；
  - 群聊：必须 @ 到机器人；**删除「已绑定话题免 @」分支**（含对 `session-map` 已有键的判断）；
  - bot open id 未知时保留上一刀兜底：有任一 mention 放行（debug 标注）；
  - 不满足时丢弃并 debug：`group message without mention ignored (chat …, thread …)`。
- 保留 `sender_type !== 'user'` 的机器人/应用消息过滤（归一化层第一判定 + lark 入口 debug）。
- 单人群豁免仍未实现（需要 chat 成员 API + 缓存，成本大于收益）。
- 测试：原「已绑定话题免 @」改为 **「已绑定话题仍需 @」**；新增「群内话题加 @ 后正常处理」「bot 消息即使 @ 也不进入会话」。

### 1.2 agent 就绪后强制重渲状态卡

- 新增 `Bridge#afterAgentReady(state)`：在 `create` / `resume` 返回后，从 `sessionTitle.get(session)` 拉取标题写入 `state.title`，**若该 scope 已有状态卡 message_id，则就地 `#renderStatus` 一次**（复用同一 `CardStream` 节流，不新发消息）。
- 挂接点：`#tryResolve`（覆盖普通消息、`/rename`、未知命令解析）与 `/resume` 成功之后。
- 保留上一刀的 `session/title` 增量重渲；`/new`、`/resume` 会清空旧标题缓存，避免串标题。
- 测试：先渲染出状态卡（显示「标题生成中」），让标题在服务端出现，再触发一次 agent 解析；断言**卡片总数不变、同一 message_id 被 patch、内容含标题**。

### 1.3 `/sessions` 行格式

- 每行统一为：`· <标题> · <时间> · <sessionId 前 8 位>`。
- 标题：`sessionTitle.get(session)`（该会话有 live agent 时）；缺失/空标题显示 **`（未命名）`**，不出现空白。
- 时间：该 scope 最近一次 `turn/start` / `turn/end` / 事件时间，UTC `HH:MM:SSZ`；未知时 `—`（例如本进程内还没产生事件的会话）。
- 当前会话与上一会话（`/resume` 目标）都按该格式输出。
- 测试：有标题行匹配 `会话标题 · HH:MM:SSZ · <前8位>` 且不打印完整 sessionId；无标题行显示 `（未命名）`。

## 2. 测试

- 原有 118 例全部保留（其中 1 例按新语义改写断言），新增 5 例，共 **123 例全绿**。
- 全部注入式（假 transport / 假 agents / 假时钟 / mkdtemp），不碰真飞书与真 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 群聊（含话题）无 @ 不响应 | 在已绑定话题里不 @ 机器人发消息：不应出现任何 agent 回复、不建新会话，服务日志有 `group message without mention` |
| 2 | 双 bot 同群不再抢答 | 同一群/话题两个 bot 在线时，@ 指定 bot：只有被 @ 的 bot 接；不 @ 时都不接 |
| 3 | p2p 不需要 @ | 私聊直接发消息仍正常回复 |
| 4 | 群内话题 @ 后仍复用同一会话 | 已绑定话题 @ 机器人后回复落在同一话题、同一 sessionId（session-map 键不变） |
| 5 | 状态卡标题 | 首轮状态卡先显示「标题生成中」，agent 就绪/标题落盘后变成真实标题，且仍是同一张卡片（无新消息）；`/status` 同步显示 |
| 6 | `/sessions` 展示 | 输出三行格式「标题 · 时间 · sessionId 前 8 位」；无标题会话显示「（未命名）」；不泄露完整 sessionId |
| 7 | bot 消息过滤仍生效 | 应用/机器人自改进通知不再进入会话与 fallback 标题 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 生产已有会话不会被改写；如需修正旧标题用 `/rename`。
