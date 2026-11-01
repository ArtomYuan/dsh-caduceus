# dsh-caduceus 设计稿

> 给 dsh 套一层 Hermes Agent：装完 dsh、装这一个包，就在聊天软件里按 Hermes 的方式用它。
> 名字取赫尔墨斯的**双蛇杖**（caduceus）——传令之权，不是神名。对外只说「受 Hermes Agent 的网关设计启发」。
> 版本：v0.5 · 2026-10-31 · 依据本机 dsh 0.2.1-rc.2

---

## 1. 目标

套一层**外壳**，两层自制 + 一处借用：

| 层 | 内容 | 归属 |
|:--|:--|:--|
| L1 人格 | SOUL，写进 `~/.agents/AGENTS.md` 的标记块 | 自制 |
| L2 会话 | 一个话题一个会话、`/new`、`/sessions`、`/resume` | 自制 |
| L2 标题 | derived → llm → user | **借官方**（服务 + provider 都已存在） |
| L3 交互件 | 命令转发、卡片过程、终稿、忙时三档 | 自制 |

硬约束：**一个包**。`dsh plugin add <pkg>` → 填凭据 → 重启。官方包由本包的 patch 一并插入，用户不用另装。

## 2. 非目标

- 不重写 dsh 的 agent loop、工具、沙箱、权限、会话日志、压缩。
- 不做多平台、TTS、Web 面板。
- **不做记忆**（USER / MEMORY / memory 工具）。要时再加一个 entry，不动现有结构。
- 不搬 Hermes 的存储。dsh 的 append-only 会话日志是唯一事实源。

> 代价：没有记忆，每个新会话都是白纸。人格靠 SOUL 连续，经验不连续。

## 3. 边界

| 能力 | dsh 自带 | 外壳补 |
|:--|:--|:--|
| agent loop / 工具 / 沙箱 / 技能 / 子代理 | ✅ | — |
| 会话日志 / 工作区记账 | ✅ | — |
| 上下文压缩 | ✅ 自动四件套 ＋ `/compact` 命令 | 转发即可 |
| 中断与三种投递 | ✅ `followup` / `steer` / `inject` / `cancel` | 映射成命令与忙时策略 |
| 标题生成与存储 | ✅ base 已挂 `session-title` + `session-title-llm`（first-prompt）+ 确定性 fallback（2026-10-31 实测） | **什么都不用插**，只调 `rename()` / `get()` |
| 人格 | ❌（`dsh-persona` 只吃内联字符串） | L1 |
| 会话键 | ❌（无 IM 概念） | L2 |
| IM 渲染 / 命令入口 | ❌ | L3 |
| 长期记忆 | ❌ | ❌ 明确不做 |

## 4. 关键判定：人格落在哪

| 方案 | 证据 | 结论 |
|:--|:--|:--|
| 自建 preset | `dsh-agent-preset` 的 Config 只有 `{id, name, description, order, plugins}`，**没有 extends** | ❌ 抄整条工具链 |
| 补丁改 standard 的 persona 行 | patch 的 `config` 是整段替换 | ❌ 要重述 plugins 数组 |
| 根作用域注册 section | `dsh-persona` 注释：与 prompt registry 自身 persona 行冲突并拒绝 | ❌ 死路 |
| **写进 `~/.agents/AGENTS.md`** | `dsh-agent-instructions` 有两个 user-global 根：`$DSH_HOME/AGENTS.md` 与 `$DSH_AGENTS_HOME/AGENTS.md`（默认 `~/.agents`），同组、同预算、相同内容只渲染一次 | ✅ **独立文件，不污染工作指令** |

```md
<!-- dsh-caduceus:soul:start -->
（SOUL.md 全文）
<!-- dsh-caduceus:soul:end -->
```

### 预算约束（必读）

- `maxBytes` 是**整个 baseline 的预算**，不是单文件。
- 超预算时按「保留更具体、丢弃更宽泛」裁剪：`files.slice(start)` 保留尾部，head 被丢——**全局文件先被截**。
- 裁剪是静默的，只留一行 `Workspace instructions were omitted or truncated to fit the configured byte budget.`

所以：人格块必须短（建议 ≤2 KB），验收要盯渲染里的 budget 行，不能只看「文件里有内容」。

## 5. 参考源：Hermes 的不变式

| 不变式 | 源码位置 | 用途 |
|:--|:--|:--|
| 会话键含 thread | `gateway/run.py::_parse_session_key`（`…:{chat_type}:{chat_id}[:{thread_id}]`，`chat_type ∈ {dm, thread}`） | L2 |
| 标题三级权威 | `hermes_state_titles.py` | L2（dsh 已内建同构语义） |
| 首响不等标题 | `title_generator.py::derive_title` / `generate_title` | 由 dsh 的 fallback + provider 承担 |
| 过程编辑、收尾新发 | `platforms/base.py::prefers_fresh_final_streaming` | L3 |
| 忙时三档 | `slash_commands.py` 46–49 行 | 直接映射 dsh 的三个投递方法 |

## 6. 功能矩阵

### L1 人格

| 能力 | v0.1 | 要点 |
|:--|:--|:--|
| 人格注入 | ✅ | 同步 `~/.agents/AGENTS.md` 的 soul 块；只动标记之间 |
| `/persona show` / `sync` | ✅ | 回显与手动 reconcile |

### L2 会话与标题

| 能力 | v0.1 | 要点 |
|:--|:--|:--|
| 会话键 `(chat, thread)` | ✅ | `scopeKey = chatId + "\u0000" + threadId`；无话题回落 chatId |
| `/new` | ✅ | 铸新 sessionId，旧会话保留 |
| `/sessions` | ✅ | 标题取自 `sessionTitle.get(session)` |
| `/resume` | 🟡 | 只回本话题的上一条 |
| 标题 | ✅ **不写逻辑** | patch 插入官方 `first-prompt-llm`；`rename()` 自带 user-pin 与 supersede |

### L3 交互件

**命令走注册表转发**（`runHarnessCommand`），只维护 Web-only denylist。外壳自有：`/new` `/sessions` `/rename` `/persona` `/stop`。

| 能力 | v0.1 | 要点 |
|:--|:--|:--|
| 过程消息 | ✅ | 卡片；默认节流 400 ms（dsh-feishu 生产值，5 QPS 的一半） |
| 过程截断 | ✅ | 卡片 ≤30 KB：只放尾部约 8 KB + 步骤摘要 |
| 终稿 | ✅ | 新发 `message_id=None`；文本上限 150 KB |
| 发送兜底 | ✅ | 话题回复失败（230071/230072/230019）→ 降级 chat_id 直发；重试用 `uuid` 去重（1 小时内至多一条） |
| 忙时三档 | ✅ | `queue`→`followup` / `steer`→`steer` / `interrupt`→`cancel`+`steer` |
| `/stop` | ✅ | `cancel({ kind: 'user' })` |
| `/compact` | ✅ | 透传 |
| 工具步骤行 | 🟡 | 只显示「正在执行 N 个工具」 |
| 审批卡 / 提问卡 / 附件 | ❌ | v0.2 |
| `/model` | ❌ | v0.2 |

### L3′ 状态与可观测（同位体的必要条件）

判据来自现成事件，不需要新数据源：`turn/start` / `step/end` / `turn/end`（后者带 `reason.kind`）。

| 机制 | 行为 | v0.1 |
|:--|:--|:--|
| 状态行 | 每会话一张「当前状态」卡：进行中 / 等待输入 / 待审批 / 失败 / 完成，带步数与起止时间；终态定格 | ✅ |
| `/status` | 本会话最近事件摘要 + 是否在跑 + 有无待答/待批 | ✅ |
| 终态推送 | `turn/end` 的 reason ∈ {error, interrupted, blocked} → 主动发一条，不等用户问 | ✅ |
| `/tasks` | 本话题在跑与近期会话清单（跨话题不串） | 🟡 可延后 |

**原则**：外壳不只要把话传过去，还要把状态说清楚。少这一层，用起来会觉得「哪里不对但说不上来」。

## 7. 包结构：两个自制 entry + 一行官方

```
dsh-caduceus/
├─ package.json           # dsh.bundle.patch → cordis.patch.yml；peer 钉 dsh 同版本
├─ cordis.patch.yml
├─ src/
│  ├─ gateway/
│  │  ├─ index.ts         # entry: caduceus-gateway
│  │  ├─ transport.ts     # 长连接、归一化（带 thread_id）、发送/回复/卡片
│  │  ├─ session-key.ts   # scopeKey + JSON v3
│  │  ├─ agent-store.ts   # 包 agents：get / create / resume
│  │  ├─ turn.ts          # 同 key 串行、忙时三档
│  │  └─ render.ts        # 卡片过程（截断）、终稿、分片
│  ├─ persona/
│  │  ├─ index.ts         # entry: caduceus-persona
│  │  └─ blocks.ts        # ~/.agents/AGENTS.md 单块读写
│  └─ commands/           # 自有五条 + 转发器 + denylist
└─ DESIGN.md
```

```yaml
- insert:
    - id: caduceus-gateway
      name: 'dsh-caduceus'
    - id: caduceus-persona
      name: 'dsh-caduceus/persona'
# 注意：不要再插 title provider —— base 已挂 session-title-llm，
# 同 id 二次注册会在加载期直接报「provider already registered」。
```

不碰任何 preset。

## 8. 存储

`<DSH_HOME>/caduceus/session-map.json`：

```json
{
  "version": 3,
  "entries": { "oc_xxx\u0000omt_yyy": { "sessionId": "feishu-1793313252045" } },
  "cwd": { "oc_xxx\u0000omt_yyy": "/home/artom/.dsh/workspace" }
}
```

**标题不自存**——`sessionTitle.get(session)` 是唯一来源，事件里的 `source` 就是权威标记。

## 9. 标题

```
provider（llm）  官方 first-prompt-llm
fallback         官方 fallbackSessionTitle：首条消息、按词/字节截断、永不失败
user             rename()：写 source{kind:'user'}，supersede 自动生成，后续用户消息不再调度
```

外壳只做两件事：`/rename` 调 `rename(session, text)`；`/sessions` 调 `get(session)` 取标题。
非法输入由 `SessionTitleInvalidError` 抛回，外壳翻译成一句人话即可。

## 10. 安装

```bash
dsh plugin --profile web add /path/to/dsh-caduceus
# 填 appId / appSecret，或 FEISHU_APP_ID / FEISHU_APP_SECRET
systemctl --user restart dsh
```

Config：`appId`、`appSecret`、`defaultCwd`、`allowedChats`、`allowedUsers`、`cardThrottleMs`、`busyMode(queue|steer|interrupt)`。

## 11. 验收

| 编号 | 判据 |
|:--|:--|
| A1 | 空 DSH_HOME 只装本包，启动日志 caduceus ready ×2 + title provider 注册行 |
| A2 | 同群两话题 → 两条 key（含 `\0`）、两个 sessionId |
| A3 | 同话题连发两条 → 同一 sessionId |
| A4 | 首条后 ≤1s 有标题，`session/title` 的 source 是非 user |
| A5 | `/rename` 后 source=user；再来消息不覆盖 |
| A6 | 机器人回复 `thread_id` == 用户消息 `thread_id` |
| A7 | 过程卡片被更新 ≥2 次，终稿另一条 message_id |
| A8 | `/new` 后新 sessionId，旧会话可 `/resume` |
| A9 | 新会话 system prompt 含 soul 段 |
| A10 | 人格块渲染后仍在预算内（budget 行无 omitted） |
| A11 | `~/.agents/AGENTS.md` 的 diff 只有标记块；重复重启不产生第二块 |
| A12 | 忙时三档各自表现：queue 等下一轮、steer 下一 step 插入、interrupt 立即中断并处理 |
| A13 | `/stop` 后会话回 idle |
| A14 | `/compact` 前后 token 有可观测落差 |
| A15 | 回合进行中状态卡显示步数并递增；`turn/end` 后定格为完成 / 失败 |
| A16 | `turn/end` 的 reason=error 时主动收到一条消息，无需用户询问 |
| A17 | `/status` 在空闲与运行中两种状态下输出可区分、均非空 |

## 12. 风险

1. **一路长连接**：一个飞书应用只能有一个消费者。
2. **载体限制**：文本每条最多编辑 20 次（230072）；卡片无次数上限，但 14 天窗口、单条 30 KB、必须 `update_multi: true`。
3. **指令预算**：全局文件先被裁；人格块必须短，且要验证未被截。
4. **自维护外壳要跟核心升版**：peer 钉版本，升级后跑 A1–A3。
5. **无记忆**：新会话是白纸。
6. **话题回复不是所有群都支持**：230071 / 230072 只在运行时出现，必须有降级路径（chat_id 直发），否则一条失败就断流。

## 13. 分期

| 版本 | 内容 | 估算 |
|:--|:--|:--|
| v0.1 | 人格块 + 会话键 + `/new` `/sessions` `/rename` `/persona` `/stop` + 卡片过程 + 终稿 + 忙时三档 + 标题（借官方） | **1400–1700 行，4–5 天** |
| v0.2 | 附件、审批卡、提问卡、`/model`、cardkit 原生流式 | +3 天 |
| 暂不做 | 记忆、多平台、TTS、Web 面板 | — |

## 14. 已核结论（2026-10-31，只读）

| # | 问题 | 结论 |
|:--|:--|:--|
| ① | 事件流 | `ctx.on("session/event", (session, event))`；agent 句柄 `get/create/resume` |
| ② | 中断 | `agent.cancel({ kind: 'user' })`，可选 `keepInbox`；清 inbox + abort 当前 phase |
| ③ | 飞书频控 | 文本 PUT 每条 ≤20 次（230072）；卡片 PATCH 无次数上限、单条 5 QPS、14 天窗口、≤30 KB、需 `update_multi: true`；应用级 1000/分、50/秒 |
| ④ | 指令 reconcile | 每个 `step/end` 投影，下一个 `agent/pre-step` 生效 |
| ⑤ | 事件类型全表 | `turn/start` `turn/end` `step/start` `step/end` `tool/call` `tool/result` `tool/ptc-dispatch(-start)` `assistant/attempt` `assistant/message` `session/created` `session/disposed` `session/end-seed` `session/flush` `session/title` `session/title-llm-request` `agent/inbox/spliced` |
| ⑥ | 三种投递 | `followup`=下一轮、`steer`=下一 step 并唤醒、`inject`=下一 step 不唤醒 |
| ⑦ | 标题服务 | `rename(session, title)` 归一化（按字节截断）→ 空则抛 `SessionTitleInvalidError` → 写 `source{kind:'user'}` 并 supersede 自动生成；`get(session)` 读折叠快照；官方另有 `fallbackSessionTitle` |
| ⑧ | 指令根 | 两个 user-global 根：`$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME/AGENTS.md`（默认 `~/.agents`），同组同预算 |
| ⑨ | 飞书 SDK | 1.76.0 的 `reply` 支持任意 `msg_type` + `reply_in_thread`；另有 cardkit 原生流式 |
| ⑩ | 话题内发卡片 | **兼容**：回复接口 `msg_type` 含 `interactive`；话题内消息默认按话题回复；卡片同样 30 KB 上限。三种失败要兜底——230071（群不支持话题回复）、230072（聚合消息不支持）、230019（话题不存在）→ 降级 chat_id 直发 |
| ⑪ | cardkit vs patch | cardkit 需「创建与更新卡片」权限、**仅 schema 2.0**、一个实体只能发一次、组件 ≤200；patch 无额外权限、无次数上限。v0.1 用 patch，cardkit 留 v0.2 |
| ⑫ | 回复去重 | 回复接口支持 `uuid`：同一 uuid **一小时内至多成功一条**——重试幂等直接用它 |

影响：标题整块不用自己写；人格换到 `~/.agents` 独立文件；忙时三档 v0.1 就能做全；工期 4–5 天。

## 15. 静态核不出来的（只能真机确认）

文档与源码能给到的都拿齐了，剩下三条属于「租户配置 / 客户端渲染」，只能试发：

1. 目标群是否允许话题回复（230071 只在运行时出现）。
2. 卡片发进话题后，客户端是否把它折叠进话题而不是平铺。
3. 卡片 patch 在话题内的视觉刷新是否顺滑（有无闪烁）。

## 16. 待排查：完成回执未送达（2026-10-31，构建期实测）

### 现象

第一刀 16:16 投出、16:26 `turn/end completed`，但**没有任何结果消息落到话题里**——16:34 我才靠自己翻会话日志发现已完成。

### 证据

- 飞书 API 拉话题消息（`container_id_type=thread`，50 条）：16:16–16:34 之间只有过程卡片（`interactive`，同一张头像图，成对出现）与我自己的回复，**16:26 之后到 16:34 之间没有一条 app 消息**。
- 过程卡片在 16:16:38 / 16:17:19 / 16:20:37 / 16:21:42 / 16:22:45 / 16:25:01 / 16:26:06–12 连续出现——说明**直播通道是通的**，问题不在投递能力。
- dsh 侧 journal 只有 `[dsh-hermes-link] 工作区请求 / 沙箱档请求` 两行，没有任何 settle / 终态日志。
- Hermes 网关到 `127.0.0.1:8090` 有一条 **ESTAB** 长连接（fd=19），说明至少一路 stream 仍挂着。

### 已排除

- 不是「发到顶层的会话而不是话题」：按 `container_id_type=chat` 拉取，同时段也没有结果消息。
- 不是投递失败：`_deliver_final_result` 的失败路径是 `logger.warning`，journal 里没有对应行。

### 假说（按可能性排序）

1. **`consume_stream` 从未返回**：终态送达只在 `consume_stream` 返回之后调用（`_stream_dsh_call` 末尾），流不结束就永远不投递。
2. **同一会话被第二个任务复用**：16:35 第二刀投进同一个 session（同 context + 同 cwd），若服务端的 settle 判据是「会话无活跃工作」，新回合会让前一个任务迟迟不结算。
3. 服务端 `TASK_STATE_COMPLETED` 未写出，客户端一直在等终态帧。

### 对 caduceus 的影响

**不依赖上游把终态推给你。** caduceus 自己在 `turn/end` 上生成终态消息（§6 L3′），这条路径不经过任何 settle 逻辑，天然不会哑。

### 复现（同日 16:55，第二刀）

第二刀同样投在同一会话，16:55:20 `turn/end completed`。飞书侧：16:55:23–28 连续五条过程卡片，**之后仍无终态消息**。

新增两条证据：

- `127.0.0.1:8090` 的连接在 16:56:03 已归零——**流确实结束了**，「连接不释放」不成立。
- Hermes 侧 journal 里 `dsh-hermes-link` 自 16:30 起**一行都没有**（连 `logger.warning` 也无）。

**因此此前的推理要作废**：不是「没有 warning 所以没失败」，而是**这个插件的日志根本没进 journal**。以日志判断投递成功与否，在这条链上无效；唯一可信的判据是**平台侧消息列表**。

### 修正后的判据

| 想确认 | 唯一可信的取法 |
|:--|:--|
| 有没有送达 | 飞书 `container_id_type=thread` 拉消息列表 |
| 流有没有结束 | `ss -tnp \| grep :8090` 的连接数 |
| 任务有没有跑完 | dsh 会话日志的 `turn/end` |

三条缺一条都不足以定论——这次就是「日志干净 + 流已断 + 任务已完成」同时成立，但消息没有。

### 下一步（修正）

1. 先让插件日志可见（提高该 logger 级别或加文件埋点），否则永远只能靠猜。
2. 再看 `make_sender` 返回的 dict 是否 `ok=false`——它不抛异常，只回结构化结果，失败在无日志时完全静默。

---

## 附录：旧 README（用户文档归档，2026-11）

# dsh-caduceus

> 给 dsh 套一层 Hermes Agent 风格的飞书外壳：一个话题一个会话、SOUL 人格块、`/new` `/sessions` `/resume` 等命令、节流过程卡片（答案也在卡里）、`/status`。
> 名字取赫尔墨斯的**双蛇杖**（caduceus）——传令之权，不是神名；设计受 Hermes Agent 的网关思路启发。

**状态：第二刀（v0.1 功能面完成）。** 飞书长连接、消息归一化、agent 桥接、过程卡片、忙时三档、标题与命令接线均已实现；测试全部用注入式假 transport / 假 agents，不需要真飞书凭据，也不读写真实 `~/.dsh`。真机验收（A1–A17）清单与验证方法见 [docs/SLICE2.md](docs/SLICE2.md)；第三刀（真机缺陷修复 + 话题语义）见 [docs/SLICE3.md](docs/SLICE3.md)；设计稿见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录结构

```
dsh-caduceus/
├─ package.json              # dsh.bundle.patch → cordis.patch.yml；peer 由 dsh 运行时提供
├─ cordis.patch.yml          # 两条自有 entry + 官方标题 provider（三行 insert）
├─ tsconfig.json             # NodeNext · strict
├─ src/
│  ├─ index.ts               # entry: caduceus-gateway（配置 → transport → bridge 接线）
│  ├─ persona/index.ts       # entry: caduceus-persona（/persona 注册进 dsh 命令注册表）
│  ├─ config.ts              # schemastery Config + 环境变量兜底
│  ├─ home.ts                # DSH_HOME / DSH_AGENTS_HOME 路径解析（不展开 ~）
│  ├─ atomic-write.ts        # 先写 .tmp 再 rename
│  ├─ session-key.ts         # scopeKey + session-map.json v3（兼容 v1/v2）
│  ├─ status.ts              # 状态层：运行中/等待输入/待审批/失败/完成/已中断 + 步数/起止
│  ├─ transport/             # 长连接与归一化（thread_id ?? root_id）、reply 降级、uuid 去重
│  ├─ bridge/                # 同键串行、忙时三档、事件订阅、终稿新发
│  ├─ render/                # 卡片、节流 CardStream、UTF-8 截断
│  ├─ persona/blocks.ts      # AGENTS.md 的 soul 块读写（只动标记之间）
│  └─ commands/              # 八条命令解析 + dsh 注册表转发 + Web-only denylist
├─ test/                     # node:test（假 transport/agents，全部 mkdtemp）
├─ scripts/smoke.mjs         # 构建产物冒烟（仅临时目录）
└─ docs/                     # 设计稿 + 第一刀 VERIFY + 第二刀 SLICE2
```

## 安装

本包是 dsh bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh plugin add` 一个包即插入两条自有 entry 与官方标题 provider，不需要另装官方包。

```bash
# 本机 Node 工具链在 /home/artom/.local/bin（默认 PATH 未包含时先加进去）
export PATH="/home/artom/.local/bin:$PATH"

# 开发 / 构建
pnpm install
pnpm build       # tsc → dist/
pnpm typecheck   # tsc --noEmit（src + test）
pnpm test        # 编译测试后 node --test
pnpm smoke       # 纯逻辑冒烟（临时目录，不碰 ~/.dsh）

# 装进某个 profile（何时重启 dsh 由宿主统一执行，本包与服务脚本无任何关系）
dsh plugin --profile web add /home/artom/agent-workspace/dsh/worktrees/dsh-caduceus
```

> 真机联调需要一个已开通机器人能力的飞书应用（`appId` / `appSecret`）。**不要在生产 profile 上直接试**；临时 profile 的复制、安装、冒烟与清理步骤见 [docs/VERIFY.md](docs/VERIFY.md) 与 [docs/SLICE2.md](docs/SLICE2.md)。

## 配置

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `appId` | — | 飞书应用 App ID；可用环境变量 `FEISHU_APP_ID` 兜底 |
| `appSecret` | — | 飞书应用 App Secret；可用环境变量 `FEISHU_APP_SECRET` 兜底 |
| `defaultCwd` | 进程 cwd | 新建会话的工作目录 |
| `allowedChats` | 空（全部） | 允许服务的 chat id 白名单 |
| `allowedUsers` | 空（全部） | 允许服务的用户 open_id 白名单 |
| `cardThrottleMs` | `400` | 过程卡 patch 节流（Feishu 5 QPS 的一半） |
| `busyMode` | `queue` | 忙时策略：`queue` → followup、`steer` → steer、`interrupt` → cancel+steer |
| `groupSessionsPerUser` | `true` | 普通群按发送者隔离（Hermes 默认）；`false` 回退整群共享。话题键不受此开关影响；启动日志会打印 `groupSessionsPerUser=<bool>` |
| `logLevel` | `info` | 文件日志级别：`info`（默认）或 `debug` |
| `personaAutoSync` | `true` | 启动时自动把 SOUL 同步到 `$DSH_HOME/AGENTS.md`（幂等；`false` 时零调用） |
| `agentPreset` | `standard` | 插件创建/恢复会话时挂载的 dsh agent preset（启动日志 `agent preset=<id>`） |

缺凭据时 entry 仍然加载（`caduceus-gateway ready`），但**不会启动长连接**，profile 因此保持可引导。

## 命令

| 命令 | 说明 |
|:--|:--|
| `/new` | 为当前聊天/话题**立即创建**新会话（写 map 前先 create，失败不写 map），旧会话保留；回复只显示短 id |
| `/sessions [--all]` | 默认只列当前 scopeKey：`▸ 标题 · 时间 · sessionId 后 8 位`（当前行 `* `，无标题「（未命名）」，末尾提示 `/rename`）。时间优先从 `feishu-<epoch_ms>` 解析（刚刚 / N 分钟前 / N 小时前 / MM-DD HH:mm），解析不出才 `—`。`--all` 列出同一 chatId 下所有 scope 的**当前 + history**（旧键/话题/用户/历史会话），行尾加 scope 标签与必要时 `（未落地）`，末尾提示用 `/resume <id 后 8 位>` |
| `/rename <标题>` | 重命名当前会话的标题（标题非法时回一句人话） |
| `/resume [id\|尾号]` | 无参恢复本 scope 上一条；带参可按完整 sessionId 或 ≥8 位不歧义**尾号**在本 chat 所有 scope 的**当前 + 全量 history** 中恢复；命中后该 id 成为当前并置于 history 首位（命中多条给歧义提示） |
| `/adopt <id\|尾号>` | 把一条无归属的会话显式收养到**当前 scopeKey**（加入 history 并设为当前）；已在其他 scope 下会提示位置、歧义列候选、零命中给提示 |
| `/selfcheck` | 立即重跑启动自检，逐项输出 `ok/fail/skip` 与详情 |
| `/doctor [--json]` | 输出分段体检报告（运行时/飞书/人格/会话/存储/版本），文本或机器可读 JSON（`warnings`/`lastTurn` 同步）；结论四段 `正常/异常/提示/跳过`；命令回合无数据项显示 pending 原因，最近 agent 回合缓存显示「上一回合」；跑完记一行 `doctor: N ok / M fail / K skip` |
| `/stop` | 中断当前正在运行的一轮（`cancel({kind:'user'})`） |
| `/status` | 显示本会话状态、步数、工具数、起止时间与最近事件 |
| `/persona [show\|sync]` | 查看或同步 SOUL 人格块 |
| `/help` | 显示命令表 |

其他 `/命令`（例如 `/compact`）会**原样转发**给 dsh 命令注册表（`ctx.get('commands').execute`）；Web-only denylist（至少 `/export`）直接在飞书侧拒绝，不转发。普通消息交给 agent。

## 群聊门禁与话题语义

- **非人类消息一律丢弃**：`sender.sender_type !== 'user'`（应用 / 机器人 / 缺失）在归一化层就被过滤，绝不会成为 prompt 或 fallback 标题（真机事故：应用自改进通知被当成首条用户消息）。
- **p2p**：不需要 @。
- **群聊（含群内话题）**：**一律需要 @ 到机器人**才处理；不 @ 直接丢弃并 debug 记一行 `group message without mention`。
  - 话题**不再免 @**：真机实测同一话题两个 bot 同时在线时，免 @ 会导致两个 agent 同时接同一句话（2026-10-31 17:39），用户定案群聊一律 @。
- 单人群豁免暂未实现（需要 chat 成员 API 与缓存，成本大于收益）；未实现前统一按 @ 规则，行为可预测。
- @ 判定依据：事件里的 mention open_id 与 `bot/v3/info` 解析出的机器人 open_id 比对；解析失败时退化为「有任一 mention 就放行」，并在 debug 日志里标注。

## 状态层与卡片

- **过程卡（每回合，唯一卡片）**：每回合一张，`cardThrottleMs` 节流（默认 400 ms）；运行中显示状态行（会话标题 · 状态 · 步数 · 工具 · 已运行）、`最近：<工具名或事件>`（≤40 字）与**助手正文尾部（≤8 KB 预算）**；`turn/end` 时**编辑同一张卡**到终态并渲染完整正文（卡体 ≤30 KB，超出保留尾部并加「…已省略 N 字符」）。一个回合对外只有这一张卡 + 若干 patch，不另发正文文本。
- **状态**：过程卡的状态行即为每话题状态（空闲 / 运行中 / 待审批 / 失败 / 完成）；`/status` 命令输出保留。从未跑过回合的会话是「空闲」，有回合且结束后才是「完成」。
- **标题时序**：标题未就绪时过程卡不写标题；`session/title` 到达后**就地 patch 同一张过程卡**（复用节流），不新发消息；agent create/resume 完成后还会**强制重渲一次**现有过程卡（首渲染可能早于标题服务就绪，只 patch、不新发）。
- **收尾（答案就在过程卡里）**：`turn/end` 后**编辑同一张过程卡**为终态（完成/失败/已中断）+ 完整正文，不另发文本；一个回合对外只有 1 个 `message_id` + 若干次 patch。标题在收尾时从服务/缓存读取并写入卡内状态行。
- **唯一降级出口**：卡片编辑失败（抛错/返回失败）时才发一条文本，内容与卡一致，并记日志 `final fallback to text: <reason>`；不会双发。
- `turn/end` 的 `reason.kind ∈ {error, interrupted, blocked}` 时再主动推一条消息，无需用户询问。
- **回复位置**：入站 `thread_id ?? root_id` 归一为话题 id，出站 `reply_in_thread` 回同一话题；230071 / 230072 / 230019 自动降级为 `chat_id` 直发。
- **重试幂等**：每次发送带 `uuid`，降级/重试复用同一 uuid（飞书侧 1 小时内至多成功一条）。

## 日志（可见诊断）

插件自己的 `ctx.logger` 行在真机上进不了 journal，因此本包**另写一份文件日志**（控制台日志保留）：

- 路径：`$DSH_HOME/caduceus/caduceus.log`（目录自动创建，文件 `0600`）；
- 行格式：`2026-10-31T21:07:35.123Z INFO  [caduceus] message`；
- 级别：`info`/`warn`/`error` 默认写出；`debug` 由 `logLevel: 'debug'` 打开；
- 轮转：单文件超过 5 MB → 重命名为 `.1`，旧文件顺移，最多保留 `.1/.2/.3`；
- 启动行：`ready appId=cli_xxx…abcd defaultCwd=… groupSessionsPerUser=… throttle=… busyMode=…`（appId 只露前 7 + 后 4 位，**appSecret 任何片段都不打印**）；
- 门禁每条判定一行：`gate accept: p2p|mentioned …` / `gate drop: no-mention|bot-sender|not-allowed-chat|not-allowed-user|empty-text …`，附 `chat=`/`thread=`/`sender=` 前 12 位；
- 命令分发：`command: /status`、`command: unknown passthrough /xxx`、`command: parse-fail <原文前 40>`；
- 归属补录：启动一行 `backfill: scanned=N adopted=M skipped=K`；
- 启动自检：全过打 `selfcheck: ok preset=<id> tools=<n> persona=<bytes>B`；启动时服务尚未注册（惰性）打 `selfcheck: ok (skipped: preset:service, tools:service; deferred to first session)`；任一失败打 **ERROR** `selfcheck: FAIL <items>`。**自检 fail 会同时在出问题的会话里发一条文本**：`⚠ 自检异常 preset:applied — agent 无工具无人格（详情 /doctor）`（同组去重、组合变化再提示、恢复发 `✓ 自检已恢复` 一次）；ready 阶段 fail 无会话可发，等首条消息补发。`/status` 顶部三态：`自检 ✓` / `自检 ○（待首会话验证）` / `自检 ✗ <fail 项>`，有 fail 时追加 `最近异常：<项> @ <相对时间>`；`/selfcheck` 输出逐项 ok/fail/skip 与原因；工具数只取该会话首条 `request/header.tools`（模型实际收到的清单），未收到时显示 pending，不误报；
- 会话键：`scope: kind=p2p|topic|group-user|group-shared key=<前 16 位> session=<后 8 位>`。

## 存储

`$DSH_HOME/caduceus/session-map.json`，当前 **version 5**：

```json
{
  "version": 5,
  "entries": {
    "oc_xxx\u0000ou_user": {
      "sessionId": "feishu-1793464086695",
      "history": ["feishu-1793464086695", "feishu-1793463503786"]
    }
  },
  "cwd": { "oc_xxx\u0000ou_user": "/home/artom/agent-workspace" }
}
```

- 键：与 Hermes `build_session_key` 一致的三分规则：
  - p2p：`chatId`（无 chatId 回落 sender）；
  - 普通群（无话题）：`chatId + "\u0000" + sender_open_id`（**按人隔离**，与 Hermes `group_sessions_per_user` 默认一致；`groupSessionsPerUser=false` 时回退 `chatId` 整群共享）；
  - 群内话题：`chatId + "\u0000" + threadId`（多人共享，与 Hermes `thread_sessions_per_user` 默认一致）。
- 每个 key 保存 `sessionId` + `history`（最近 50 个，去重、新在前、当前 id 在 `history[0]`）；`/new`、`/resume` 切换、remint 都会立即原子落盘。
- 旧格式可读：v5 为当前格式；v4/v3 是 `entries` 对象（老键**原样保留**为旧共享会话，**不批量改写**，history 初始为空）；v2 是扁平 `{ "<scope key>": "feishu-<ts>" }`；v1 把这些字符串放在 `sessions` 下。下一次落盘写成 v5。
- 因此进程重启后 `/sessions --all` 仍能列出旧 id，`/resume <尾号>` 仍能找回历史会话。
- `/new` 会先调用 `agents.create` 再写 map；create 失败则不写，避免「幽灵 id」。`/sessions` 对 map 中存在、但磁盘无会话文件且无 live agent 的条目标注 `（未落地）`。
- 会话归属：`agents.create` 的 `meta` 带 `{ cwd, caduceus: { chatId, scopeKey, kind } }`，并在 `<DSH_HOME>/caduceus/owners/<sessionId>.json` 写归属 sidecar（dsh 0.2.1-rc.2 重建 header 时会丢弃未知字段，sidecar 是实际持久来源）。
- 启动补录：扫描 `$DSH_HOME/sessions/*/feishu-*/`，从 sidecar 或明文 JSONL 头部读回 `meta.caduceus`，把该 id 追加进对应 scope 的 history（不改当前、幂等、≤50），启动日志打一行 `backfill: scanned=N adopted=M skipped=K`。
- `/adopt <id|尾号>`：把无归属会话显式收养到当前 scope（加入 history 并设为当前）；已在其他 scope、歧义、零命中都有提示，用于抢回存量孤儿。
- 写入是原子的：先写同目录 `.tmp`，再 `rename` 覆盖；权限 `0600`。
- 标题不落此表：唯一来源是 dsh 的 `sessionTitle.get(session)`。

`$DSH_HOME` 默认 `<用户 home>/.dsh`；`$DSH_AGENTS_HOME` 默认 `$DSH_HOME/../.agents`。源码里一律用 `os.homedir()` 拼接，不依赖 shell 展开 `~`。

## 人格块

插件创建的会话会带上 `meta.agentPreset`（默认 `standard`）并在 `setup` 里 `agentPresets.mount` 挂载；`agentPresets` 服务按需惰性解析（插件 apply 时它可能尚未注册），成功后缓存、失败不缓存 undefined、下次 create/resume 重试；恢复旧会话（头里没有 preset）时同样补挂一次，已有 preset 的会话用 `composedPreset` 判定跳过。挂载失败只 warn 并在过程卡状态行标「（preset 未挂载）」，会话仍可用。

启动时（飞书长连接启动之前）自动执行一次人格同步，无需手动发 `/persona sync`；内容未变时不写盘，源缺失时跳过，异常只记一行 warn、不阻断启动。日志形如 `persona: synced soulBytes=<n> agentsBytes=<n> status=created|updated|unchanged`；源缺失记 `persona: source missing; skipped`；目标 malformed 记 `persona: sync skipped (malformed)`。配置 `personaAutoSync: false` 可关闭（零调用）。

SOUL 源按顺序尝试：`$DSH_HOME/SOUL.md` → `$DSH_AGENTS_HOME/SOUL.md`（通常是 `~/.agents/SOUL.md`），同步到 **`$DSH_HOME/AGENTS.md`**（dsh agent-instructions 实际读取的用户全局指令文件）的标记块：

```md
<!-- dsh-caduceus:soul:start -->
（SOUL.md 正文，CRLF 归一化为 LF）
<!-- dsh-caduceus:soul:end -->
```

- **只替换两个标记之间的内容**，标记外一个字节不动；
- 幂等：内容相同不写盘；
- 两个 SOUL 源都不存在时**不建文件、不报错**，只记一行 info `persona source missing`；
- 旧位置 `$DSH_AGENTS_HOME/AGENTS.md` 若仍有本插件标记块，只提示「发现遗留块…可删」，**不删文件、不再写入**；`/persona show`/`sync` 均会显示真实目标路径与存在性；
- 目标文件损坏时返回状态（`malformed`），不抛错，不破坏原文件；
- 建议正文 ≤ 2 KB（设计稿 §4 的指令预算），超限只告警。

## 与 dsh 的版本关系

`peerDependencies` 把 `@deepseek-ai/dsh-*` 钉在 **0.2.1-rc.2**（运行时由 dsh 安装提供，不打进本包）；`@deepseek-ai/cordis` 钉 `~4.0.5`、`@deepseek-ai/schemastery` 钉 `^3.18.1` —— 这两个包走独立版本线，不随 dsh 0.2.1-rc.2 发版，是不对齐 0.2.1-rc.2 的例外。飞书 SDK `@larksuiteoapi/node-sdk ^1.76.0` 是本包的运行时依赖。

## 边界

- 不改 dsh 安装目录、不改任何 preset；
- 不写 `$DSH_HOME` 下的 sessions / storages / feishu 生产数据；
- 不启动、停止、重启任何服务（服务生命周期由宿主统一管理）；
- 单测一律使用 `mkdtemp` 临时目录与注入式假实现，不读真实 `~/.dsh`、不需要飞书凭据。
