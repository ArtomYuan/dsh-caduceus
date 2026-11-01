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
