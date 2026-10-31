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
| 标题生成与存储 | ✅ `session-title` 服务 + `first-prompt-llm` 等 provider + 确定性 fallback | 只插 provider 行，不写逻辑 |
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
      name: '@artomyuan/dsh-caduceus'
    - id: caduceus-persona
      name: '@artomyuan/dsh-caduceus/persona'
    - id: session-title-first-prompt      # 官方，随本包一同插入
      name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
      config: { maxTitleBytes: 120, fallbackMaxBytes: 80 }
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
