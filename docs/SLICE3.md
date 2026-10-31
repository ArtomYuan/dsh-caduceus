# 第三刀：真机缺陷修复 + 话题（topic）语义

状态：**代码与单测完成；需按宿主流程重装并重启后做第二轮真机确认**。本刀未安装进任何 profile、未重启服务、未触碰生产 `~/.dsh` 下的 sessions / storages / caduceus 数据。

## 0. 真机证据（2026-10-31 17:11，生产会话 `feishu-1793437914878`）

| 现象 | 根因 |
|:--|:--|
| 会话首条「用户消息」是机器人/应用发的自我改进通知（`sender_type=app`），fallback 标题变成 `💾 自我改进：技能 'deepseek-har…` | `normalize` 只取 `sender_open_id`，没有过滤机器人/应用消息 |
| 状态卡显示「会话：（无标题）」，而日志里已有两条 `session/title` | 卡片在标题落盘前渲染，之后没有在 `session/title` 事件上重渲染 |
| `~/.agents/AGENTS.md` 未生成 | 人格源只查 `<DSH_HOME>/SOUL.md`；源缺失时静默不动，但没有第二个合理源位置与日志说明 |

## 1. 本刀改了什么

### 1.1 非人类消息一律不入会话（优先级最高）

- `src/transport/normalize.ts`：**第一判定**改为 `sender.sender_type !== 'user'` → 返回 `undefined`（缺失 `sender_type` 也按非人类处理，fail closed）。
- `src/transport/lark.ts`：事件入口先判 `sender_type`，非人类直接 `debug` 一行
  `ignoring non-human Feishu message (sender_type=…)`，不再进入归一化/会话。
- 测试（transport）：`app` / `bot` / `system` / 缺失 sender_type 全部丢弃；人类消息通过并保留 `mentions`。

### 1.2 @ 门禁 + 话题豁免

- `InboundMessage` 新增 `mentions?: readonly string[]`（归一化从事件 mentions 提取 open_id）。
- `Transport` 新增可选 `getBotOpenId?()`；真实实现 `LarkFeishuApi` 启动时调用 `bot/v3/info` 解析机器人 open_id（失败只 warn，不影响连接）。
- `src/bridge/bridge.ts` 新增 `#accepts(message)`：
  - p2p：直接放行；
  - 群消息：mention 含机器人 open_id 才放行；
  - **群内话题**：该 `scopeKey` 在 session-map 已有会话则免 @；新话题首条仍需 @；
  - bot open id 未知时退化为「有任一 mention 放行」（避免全丢，debug 标注）。
- **单人群豁免未实现**（取舍）：需要 `im/v1/chats` 成员统计与缓存，成本高且会引入额外 API 依赖；当前统一按 @ 规则，行为可预测。若后续要做，应先加 chat-stats 缓存与阈值配置。
- 测试（bridge）：p2p 免 @；群无 @ 静默丢弃且不建会话；@ 其他用户无效；@ 机器人通过；已绑定话题免 @；新话题首条无 @ 被忽略、加 @ 后建档；bot id 未知时 mention 放行。

### 1.3 状态卡标题时序

- `StatusTracker` 之外，`ScopeState` 增加 `title?: string`。
- 订阅 `session/title`：取 `data.title`（回退 `sessionTitle.get(session)`）存入 state；**仅在该 scope 已有状态卡 message_id 时**就地 patch（复用 `CardStream` 节流），绝不新发消息。
- 渲染路径标题缺失时写「标题生成中」（不再写「（无标题）」）；`/status` 与状态卡共用同一标题来源。
- `/rename` 成功后同步更新缓存标题并就地刷新状态卡。
- 测试（bridge）：标题到达后状态卡内容变化、message 数不变、同一 message_id 被 patch；标题先到时首张状态卡直接使用标题；无标题时显示「标题生成中」。

### 1.4 人格源回退

- `src/home.ts` 新增 `defaultSoulCandidatePaths()`：`<DSH_HOME>/SOUL.md` → `<DSH_AGENTS_HOME>/SOUL.md`（通常 `~/.agents/SOUL.md`）。
- `src/persona/blocks.ts`：`syncSoul` / `readSoul` 按顺序尝试默认候选（显式 `soulFile` 不参与回退）；两个源都缺失时：
  - 返回 `status: 'missing'`（**不抛错、不建文件、不改 AGENTS.md**）；
  - 记且仅记一行 info `persona source missing (tried …)`。
- `src/persona/command.ts`：同步缺失时返回可读提示（`未找到 SOUL 源…未改动 AGENTS.md`），不当作 error；`src/persona/index.ts` 与 `src/index.ts` 都把 logger 透传下去。
- 测试（persona-source）：两源优先级；DSH_HOME 缺失时回退 AGENTS_HOME；两源缺失时 missing + 单行 info + 不建文件；显式路径不参与回退；`/persona sync` 缺源时返回可读提示。

## 2. 测试

- 原有 101 例**全部保留**，新增 16 例，共 **117 例全绿**。
- 全部注入式：假 transport / 假 agents / 假时钟 / mkdtemp；不需要飞书凭据，不读真实 `~/.dsh`。

## 3. 仍需真机确认（重装重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 应用/机器人消息不再入会话 | 再次触发同类 app 通知；检查 session-map 未新建该话题条目、fallback 标题不是机器人文本、日志有 `ignoring non-human Feishu message` |
| 2 | 人类事件确有 `sender_type=user` | 正常发一条人类消息，确认进入会话；若线上缺失该字段，需调整过滤策略（当前按 fail closed 处理） |
| 3 | 群 @ 门禁 | 群内不 @ 机器人 → 无回复、不建会话；@ 机器人 → 正常回复；只 @ 其他成员 → 无回复 |
| 4 | 话题免 @ / 新话题首条要 @ | 已绑定话题内直接发消息（不 @）→ 继续同一 session；新话题首条不 @ → 被忽略；同话题 @ 后 → 新建含 `\0` 的键 |
| 5 | 标题时序 | 首轮观察状态卡「标题生成中」；标题落盘后同一 message_id 变真实标题、无新卡片；`/status` 同步显示 |
| 6 | bot open id 解析 | 启动日志/调试出现 `resolved bot open id`；若 `bot/v3/info` 失败，确认 @ 门禁退化为「有 mention 放行」且日志有 warn |
| 7 | 人格源回退 | 仅放 `~/.agents/SOUL.md`（`$DSH_HOME/SOUL.md` 不存在）时 `/persona sync` 正确写 AGENTS.md 标记块；两源都没有时日志一行 `persona source missing`、不建文件 |
| 8 | 单人群豁免 | 本刀未实现；如产品要求再补 chat-stats 缓存（需评估 API 配额） |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区里该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行；本刀只做代码与单测。
- 生产 `feishu-1793437914878` 的旧会话与标题不会被本刀修改（如需清理旧 fallback 标题，用 `/rename`，不写数据）。
