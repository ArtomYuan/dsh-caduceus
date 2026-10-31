# 第二刀：飞书传输 + agent 桥接 + 状态层

状态：**代码与单测完成；真机验收待在临时 profile 上执行**（本刀未安装进任何 profile、未启动服务、未使用真实飞书凭据）。

## 1. 本刀做了什么

### 1.1 传输层（`src/transport/`）

| 模块 | 内容 |
|:--|:--|
| `types.ts` | `Transport` 接口（sendText / sendCard / updateCard / reply）、卡片 JSON、`FeishuApiError`、230071/230072/230019 降级码表、`update_multi` 强制校验 |
| `normalize.ts` | `im.message.receive_v1` 归一化；**`threadId = thread_id ?? root_id`**，文本 mention 清理，非 text 类型忽略（附件属 v0.2） |
| `feishu-api.ts` | 低层 API 接口（create / reply / patch / start / stop / onMessage），测试可注入 |
| `reliable.ts` | 发送策略层：每次发送带 uuid；话题回复失败按降级码表改 `chat_id` 直发并**复用同一 uuid**；卡片必须 `config.update_multi=true` |
| `lark.ts` | 唯一 import `@larksuiteoapi/node-sdk@1.76` 的模块：`WSClient` 长连接 + `Client` REST，`reply_in_thread` 话题回复 |

### 1.2 渲染层（`src/render/`）

| 模块 | 内容 |
|:--|:--|
| `cards.ts` | 过程卡 / 状态卡 / markdown 卡构造器；统一 `config.update_multi=true`；文本经 `truncate` 截尾，30 KB 硬上限校验 |
| `stream.ts` | `CardStream`：首个内容立即建卡；窗口内合并为最新内容，`cardThrottleMs`（默认 400 ms）后一次 trailing patch；内容不变不 patch；时钟可注入（测试用假时钟，不 sleep） |
| `truncate.ts` | 复用第一刀的 UTF-8 安全 8 KB 截尾与「已省略 N 字符」提示 |

### 1.3 状态层（`src/status.ts`）

从 `turn/start` / `step/start` / `step/end` / `turn/end(reason.kind)` 推导：

- 状态：运行中 / 等待输入 / 待审批 / 失败 / 完成 / 已中断；
- 步数（`step/start` 计数）、工具数、`startedAt` / `endedAt` / 最近事件；
- 映射：`completed`→完成、`error`/`max-tokens`→失败、`blocked`→待审批、`aborted`/`interrupted`→已中断；
- **终态推送**：`turn/end` 的 reason ∈ `{error, interrupted, blocked}` 时主动发一条消息（失败带错误文本）；
- `/status` 与状态卡共用同一快照渲染，空闲/运行中输出可区分（A17）。

### 1.4 桥接与接线

| 模块 | 内容 |
|:--|:--|
| `bridge/scope-queue.ts` | 同 `scopeKey` 串行、异键并行 |
| `bridge/bridge.ts` | 入站 → 命令/消息分发；会话解析（`agents.get` → `resume` → `create`，resume 失败重铸 session）；`session/event` → 状态卡 + 过程卡 + 终稿；忙时三档（queue→followup、steer→steer、interrupt→cancel+steer）；终稿永远新发；终端态主动通知 |
| `commands/dispatch.ts` | 自有命令 vs 未知命令透传 vs Web-only denylist（含 `/export`） |
| `commands/harness.ts` | 未知命令转交 `ctx.get('commands').execute(...)`；未匹配返回 undefined → 回「未知命令」 |
| `index.ts` | `caduceus-gateway`：schemastery Config、凭据环境变量兜底、transport/bridge 接线、`session/event` 订阅、`ctx.effect` 启停长连接、缺凭据时 idle 挂载 |
| `persona/index.ts` + `persona/command.ts` | `caduceus-persona`：把 `/persona show\|sync` 注册进 dsh 命令注册表；网关侧共用同一处理器 |

### 1.5 测试（全部注入式，无需凭据 / 不碰 `~/.dsh`）

- `test/transport.test.ts`：thread_id/root_id 归一化、uuid、三种降级码、`update_multi`；
- `test/render.test.ts`：假时钟下「400ms 内不更新、到期只 patch 一次、内容不变不更新」、30 KB 上限、UTF-8 安全；
- `test/status.test.ts`：四种终态 + 步数 + 起止时间 + 推送条件；
- `test/bridge.test.ts`：同键串行 / 异键并行、忙时三档、终稿新发且不编辑过程卡、终端主动通知、`/new` `/resume` `/stop` `/rename` `/status` `/help` `/persona`、denylist、允许列表、resume 失败重铸；
- `test/commands.test.ts`：第一刀原有用例 + `/status` + denylist 分类（README 命令表一致性由测试守护）。

## 2. 需要真机才能验的清单（每条含验证方法）

前提：按 `docs/VERIFY.md` 复制生产 web profile 到临时 `DSH_HOME`，把本包 `dsh plugin --profile caduceus-verify add <本包绝对路径>` 后启动该临时 profile。以下全部为**第二刀联调需执行**，本刀未执行。

| # | 待验证 | 验证方法 |
|:--|:--|:--|
| 1 | 长连接能建立，两个 entry 都 ready | 启动日志出现 `caduceus-gateway ready` 与 `caduceus-persona ready`（A1 的一部分；标题 provider 注册行另见 #2） |
| 2 | 官方标题 provider 是否被重复挂载 | dsh-base 已有 `- id: session-title-llm`，本包 patch 又插 `- id: session-title-first-prompt`；看启动日志/provider 注册行是否报冲突；若冲突改 patch 语义（本刀未改设计稿三行 insert） |
| 3 | 同群两话题两条 key、两个 sessionId（A2） | 在两个话题内各发一条消息，检查 `$DSH_HOME/caduceus/session-map.json` 出现含 `\0` 的两个键、两个 sessionId |
| 4 | 同话题连发两条同一 sessionId（A3） | 同一话题连发两条，观察 session-map 键未变、agent 未重建 |
| 5 | 回复落在同一话题（A6） | 在话题内 @机器人，检查回复消息的 `thread_id` 与入站一致；用 `/status` 也验证一次 |
| 6 | 话题回复降级（230071/230072/230019） | 找不支持话题回复的群（或构造失败），确认日志有 `degrading to chat_id send` 且消息只出现一次（uuid 去重） |
| 7 | 过程卡更新 ≥2 次、终稿另一条 message_id（A7） | 发一个多步任务，数过程卡 patch 次数；终稿必须是新消息而非过程卡被改 |
| 8 | 节流实际观感 | 长任务中加入 `cardThrottleMs=400`，观察卡片 patch 频率 ≤ 2.5 次/秒，客户端不闪烁 |
| 9 | 忙时三档（A12） | 分别配 `busyMode=queue/steer/interrupt`，在回合进行中发第二条消息：queue 等下一轮；steer 下一 step 插入；interrupt 立即中断并处理新消息 |
| 10 | `/stop` 后回 idle（A13） | 长任务中发 `/stop`，确认状态卡变「已中断」且 `/status` 显示 `是否在跑：否` |
| 11 | 状态卡步数递增、终态定格（A15） | 观察状态卡在 `step/start` 后步数递增；`turn/end` 后定格为完成/失败 |
| 12 | `turn/end error` 主动推送（A16） | 制造一次 provider 错误（如临时错误 key），不询问也应收到失败消息 |
| 13 | `/status` 空闲与运行中可区分（A17） | 空闲/运行中分别发 `/status`，对照输出 |
| 14 | 150 KB 终稿分片 | 让模型输出超长文本，确认终稿不超 150 KB 且飞书不报 30 KB/消息上限错误（文本消息另有限制，按需分片属 v0.2） |
| 15 | 人格块真机落盘（A9–A11） | 首次 `/persona sync` 后检查 `~/.agents/AGENTS.md` 只多标记块；重启不产生第二块；新会话 system prompt 含 soul，budget 行无 omitted |
| 16 | 标题三级权威（A4/A5） | 首条消息后 ≤1s 看 `session/title` source 非 user；`/rename` 后 source=user 且后续消息不覆盖 |

## 3. 本刀明确的未完成项

1. 未安装进任何 profile、未启动/重启服务、未连真实飞书（硬约束）——上表全部待联调。
2. 附件 / 审批卡 / 提问卡 / `/model` / cardkit 属 v0.2，本刀按设计稿不做。
3. `/sessions` 的跨会话语料、`/export` 等 Web-only 能力不在飞书侧实现（denylist 拒绝）。
4. `/tasks`（§6 L3′ 可延后项）未实现。
5. 官方标题 provider 重复挂载风险（见上表 #2）需要真机确认。

## 4. 本刀的环境备注

- 本机 registry.npmjs.org 连接不稳定（ECONNRESET），安装依赖时使用了 `--registry https://registry.npmmirror.com`；`package.json`/`pnpm-lock.yaml` 仍按公开 npm 版本声明。
- `pnpm install` 需要放行 `protobufjs` 构建，已写入 `pnpm-workspace.yaml` 的 `allowBuilds`。
