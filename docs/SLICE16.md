# 第十六刀：状态卡「尽力置顶」（pin）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 事实与目标

飞书开放平台：`POST /open-apis/im/v1/pins` body `{message_id}`；`DELETE /open-apis/im/v1/pins/:message_id`；
同一消息 pin 5 QPS；重复 pin 幂等；权限 `im:message` 已具备。
`230046` = 群仅群主/管理员可 Pin；`230047` = 限流；`230054` = 该消息类型不支持。

目标：每个 scope 的常驻状态卡创建成功后尽力置顶；失败降级绝不刷屏、不影响回合。

## 1. 改动

### 1.1 transport 两层新增 pin/unpin

- `FeishuApi`：`pinMessage(messageId)` / `unpinMessage(messageId)`；
  `LarkFeishuApi` 对应 `client.im.v1.pin.create({ data: { message_id } })` 与
  `client.im.v1.pin.delete({ path: { message_id } })`，统一走 `assertOk` 抛 `FeishuApiError`。
- `Transport` 接口 + `ReliableTransport` 透传；reliable 层**不重试** pin（230047 明确不要重试，
  其余码由桥接按策略降级）。既有 uuid/thread-fallback 逻辑不受影响。

### 1.2 持久 pin 记录（重启可找回旧 id）

新增 `src/pin-store.ts`：`<DSH_HOME>/caduceus/pins.json`，原子写（0600），
按 `scopeKey -> { messageId, chatId }` 记录已 pin 的状态卡；`load()` 容错（缺失/损坏从空开始）。
`index.ts` 创建并注入 Bridge。

### 1.3 创建后 pin 一次；新卡先 unpin 旧卡

- `#renderStatus` 每次渲染末尾调用 `#maybePinStatusCard(state)`：
  - `pinStatusCard === false` → 直接返回（零调用）；
  - 仅当状态卡 `messageId` 存在、且该 id 尚未成功 pin、也未尝试过时才动作；
  - 若 `pins.json` 里有旧 id 且 ≠ 新 id：先 `unpinMessage(old)`，成功后删除旧记录；
  - 再 `pinMessage(new)`；成功则内存 `state.pinnedMessageId = id` 并写入 pins.json；
  - 同一 scope 后续回合/事件不再重复 pin（id 不变，直接返回）。

### 1.4 失败降级

- `230046`：记 `pin denied by chat policy; disabled for <chatId 前 12>`，并把 chatId 加入
  `#pinDisabledChats`（进程内永久禁用，后续零尝试、不刷屏）。
- `230047`：记 `pin rate limited: code=230047; will retry next session`，不重试；下次会话
  新卡创建时会再次尝试。
- `230054` / 其他错误码：记 `pin failed: code=<code>`，不影响回合；本次尝试后不重复刷。
- 非 `FeishuApiError`：记 `pin failed: code=unknown`。
- 所有 pin/unpin 异常均被桥接捕获，绝不冒泡到回合主流程。

### 1.5 配置

- `BridgeConfig.pinStatusCard?: boolean`，默认 `true`（`DEFAULT_PIN_STATUS_CARD`）；
  `false` 时 `#maybePinStatusCard` 直接返回：pin/unpin 零调用，状态卡/过程卡其余行为不变。

## 2. 测试

- 原有 188 例全部保留，新增 6 例，共 **194 例全绿**：
  - `pin：状态卡创建后 pin 一次；同 scope 第二回合不再 pin`；
  - `pin：重启后新状态卡先 unpin 旧 id，再 pin 新 id`（注入 pins.json 旧记录模拟重启）；
  - `pin：230046 群策略拒绝 → 本进程禁用该 chat，回合仍完成`（日志断言）；
  - `pinStatusCard=false：零 pin/unpin 调用，状态卡与过程卡正常`；
  - transport：`ReliableTransport: pinMessage/unpinMessage 透传给 FeishuApi`；
  - config：`pinStatusCard` 默认 true / 显式 false。
- 全部注入式（假 transport/agents/clock、mkdtemp 的 pins.json），不碰真飞书与真实数据。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 状态卡被置顶 | 首次对话后该聊天顶部出现状态卡 pin；同一 scope 后续回合不再重复 pin |
| 2 | 重启后换卡 | 重启并新建状态卡：旧卡取消 pin、新卡被 pin（pins.json 中 id 更新） |
| 3 | 群策略拒绝 | 在仅群主可 pin 的群：日志出现 `pin denied by chat policy; disabled for …`，后续不再尝试，回合正常 |
| 4 | 限流 | 触发 230047：日志一行 `pin rate limited…`，不重试、不影响回合；下个会话再试 |
| 5 | 其他失败 | 230054/其他：日志 `pin failed: code=<code>`，回合/状态卡正常 |
| 6 | 关闭开关 | `pinStatusCard: false`：无 pin/unpin 调用，其余不变 |
| 7 | 权限 | 机器人具备 `im:message`（已有）；如未开 pin 权限会走其他码降级，不阻塞主流程 |
| 8 | 持久文件 | `$DSH_HOME/caduceus/pins.json` 存在且按 scopeKey 记录最新 messageId |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- pin 为纯尽力行为：任何失败都不影响状态卡/过程卡/回合；群策略禁用是进程内状态，重启后会重试。
- `230047` 不重试本进程；按需求「下个会话再试」，即新状态卡创建时再尝试（同进程新会话也算）。
- `pins.json` 只记录本插件创建的卡，跨进程以文件为准；旧版本无该文件时首次启动跳过 unpin。
