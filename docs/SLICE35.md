# 第三十五刀（P0 诊断）：交互卡片答者日志

状态：**仅新增 info/warn/error 日志；行为、超时值、卡片内容均未改。需重启后复现验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 背景

真机话题会话 `feishu-1793437914878` turn 15 调 `ask_user_question` 后永久卡住，
没有 `tool/result`/`turn/end`，日志里没有任何相关行，也看不到卡片。
无法判断是“请求没到 answerer”还是“卡片发送卡住/失败”。需要最小侵入诊断日志。

## 1. 新增日志（逐条）

### 1.1 attach

- 成功（info）：
  `interactive: attached to agent scope (total=N)`
- 非 agent scope（warn）：
  `interactive: attach skipped (not an agent scope: <typeof/keys 摘要>)`
  例：`interactive: attach skipped (not an agent scope: object keys=foo)`

### 1.2 答者被调用（info，进入后第一行）

- `interactive: approval request id=<id> questions=0 scope=<scopeKey>`
- `interactive: question request id=<id> questions=<n> scope=<scopeKey>`

id 是本次 pend 的随机 id（与按钮 value 中的 id 对应）；scopeKey 是会话 scope。

### 1.3 早退分支（warn）

- `interactive: approval skipped (approvalCard disabled)`
- `interactive: approval skipped (no session context)`
- `interactive: question skipped (questionCard disabled)`
- `interactive: question skipped (no session context)`

### 1.4 sendCard 前后

- 发送前（info）：`interactive: <kind> card sending chat=<chatId 前12>`
- 成功（info）：`interactive: <kind> card sent messageId=<id 前12>`
- 失败（ERROR）：`interactive: <kind> card send failed: <msg>`
  （approval 仍然 fail-closed 返回 cancelled；question 仍然 reject，行为未变）

### 1.5 点击回调

- 收到（info）：`card action id=<id> kind=<approval|question> operator=<openId 前12>`
- 未知/缺失 id（info）：`card action ignored (unknown id)`
- 越权仍是既有 warn：`ignored card action from non-owner ...`（本刀未改）

### 1.6 超时

- `interactive: approval timed out after <ms>ms`
- `interactive: question timed out after <ms>ms`

## 2. 排查路径（重启后）

1. 若没有 `interactive: attached to agent scope` → setup 未注册/ctx 不对（看 attach skipped）。
2. 若没有 `<kind> request id=...` → 请求根本没到 caduceus 的 answerer（上游未触发 waterfall/路由问题）。
3. 若有 request 但没有 `card sending` → 卡在 answerer 内部（上下文/早退分支，查 skipped warn）。
4. 有 `card sending` 无 `card sent` → 飞书发送卡住/失败（看 ERROR 行）。
5. 有 `card sent` 且有点击 → 查 `card action ...`；没有点击说明回调事件未到达（card.action.trigger/长连接）。
6. 有 request 且无点击 → 300s 后应看到 timed out 行。

## 3. 测试

- 原有 255 例全部保留，新增 4 例，共 **259** 全绿：
  - attach 成功与跳过各一条日志；
  - 答者入口 + sendCard sending/sent（approval/questions）；
  - 点击、未知 id、超时日志；
  - 配置关闭与发送失败（ERROR）日志。
- 日志用 FakeLogger 收集，未改任何行为断言。

## 4. 约束

- 未 npm publish、未安装、未重启；日志需重启 0.2.2 后生效。
- 没有新增每秒/每事件刷屏日志；均为单请求单行。
- 未改超时默认值（仍 300000ms）。
