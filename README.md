# dsh-caduceus

> 给 dsh 套一层 Hermes Agent 风格的飞书外壳：一个话题一个会话、SOUL 人格块、`/new` `/sessions` `/resume` 等命令、节流过程卡片、终稿新发、状态卡与 `/status`。
> 名字取赫尔墨斯的**双蛇杖**（caduceus）——传令之权，不是神名；设计受 Hermes Agent 的网关思路启发。

**状态：第二刀（v0.1 功能面完成）。** 飞书长连接、消息归一化、agent 桥接、过程/状态卡片、忙时三档、标题与命令接线均已实现；测试全部用注入式假 transport / 假 agents，不需要真飞书凭据，也不读写真实 `~/.dsh`。真机验收（A1–A17）清单与验证方法见 [docs/SLICE2.md](docs/SLICE2.md)；第三刀（真机缺陷修复 + 话题语义）见 [docs/SLICE3.md](docs/SLICE3.md)；设计稿见 [docs/DESIGN.md](docs/DESIGN.md)。

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
| `cardThrottleMs` | `400` | 过程卡片 patch 节流（Feishu 5 QPS 的一半） |
| `busyMode` | `queue` | 忙时策略：`queue` → followup、`steer` → steer、`interrupt` → cancel+steer |
| `groupSessionsPerUser` | `true` | 普通群按发送者隔离（Hermes 默认）；`false` 回退整群共享。话题键不受此开关影响；启动日志会打印 `groupSessionsPerUser=<bool>` |
| `logLevel` | `info` | 文件日志级别：`info`（默认）或 `debug` |

缺凭据时 entry 仍然加载（`caduceus-gateway ready`），但**不会启动长连接**，profile 因此保持可引导。

## 命令

| 命令 | 说明 |
|:--|:--|
| `/new` | 为当前聊天/话题新建会话，旧会话保留 |
| `/sessions [--all]` | 默认只列当前 scopeKey：`▸ 标题 · 时间 · sessionId 后 8 位`（当前行 `* `，无标题「（未命名）」，末尾提示 `/rename`）。时间优先从 `feishu-<epoch_ms>` 解析（刚刚 / N 分钟前 / N 小时前 / MM-DD HH:mm），解析不出才 `—`。`--all` 列出同一 chatId 下所有 scope（旧键/话题/用户），行尾加 scope 标签，末尾提示用 `/resume <id 后 8 位>` |
| `/rename <标题>` | 重命名当前会话的标题（标题非法时回一句人话） |
| `/resume [id\|尾号]` | 无参恢复本 scope 上一条；带参可按完整 sessionId 或 ≥8 位不歧义**尾号**在本 chat 所有 scope 内恢复（命中多条给歧义提示） |
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

- **过程卡**：每轮一张，`cardThrottleMs` 节流（默认 400 ms，内容不变不 patch），只放尾部约 8 KB 内容，卡片 ≤ 30 KB。
- **状态卡**：每话题一张，展示空闲 / 运行中 / 待审批 / 失败 / 完成（含步数、工具数、起止时间），终态定格；从未跑过回合的会话是「空闲」，有回合且结束后才是「完成」。
- **标题时序**：标题未落盘时状态卡写「标题生成中」；`session/title` 到达后**就地 patch 同一张状态卡**（复用节流），不新发消息；agent create/resume 完成后还会**强制重渲一次**现有状态卡（首渲染可能早于标题服务就绪，只 patch、不新发）。
- **终稿**：`turn/end` 后**新发**一条消息（绝不编辑过程卡），标题就绪时首行为 `▸ {标题}`、空一行后接正文；标题未就绪则只发正文（不写「未命名」）。本轮后到的 provider 标题不会补发/编辑终稿，下一轮自然带上。
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
- 会话键：`scope: kind=p2p|topic|group-user|group-shared key=<前 16 位> session=<后 8 位>`。

## 存储

`$DSH_HOME/caduceus/session-map.json`，当前 **version 4**：

```json
{
  "version": 4,
  "entries": { "oc_xxx\u0000ou_user": { "sessionId": "feishu-1793313252045" } },
  "cwd": { "oc_xxx\u0000ou_user": "/home/artom/agent-workspace" }
}
```

- 键：与 Hermes `build_session_key` 一致的三分规则：
  - p2p：`chatId`（无 chatId 回落 sender）；
  - 普通群（无话题）：`chatId + "\u0000" + sender_open_id`（**按人隔离**，与 Hermes `group_sessions_per_user` 默认一致；`groupSessionsPerUser=false` 时回退 `chatId` 整群共享）；
  - 群内话题：`chatId + "\u0000" + threadId`（多人共享，与 Hermes `thread_sessions_per_user` 默认一致）。
- 旧格式可读：v4 为当前格式；v3 是 `entries` 对象（老键**原样保留**为旧共享会话，**不批量改写**）；v2 是扁平 `{ "<scope key>": "feishu-<ts>" }`；v1 把这些字符串放在 `sessions` 下。下一次落盘写成 v4。
- 写入是原子的：先写同目录 `.tmp`，再 `rename` 覆盖；权限 `0600`。
- 标题不落此表：唯一来源是 dsh 的 `sessionTitle.get(session)`。

`$DSH_HOME` 默认 `<用户 home>/.dsh`；`$DSH_AGENTS_HOME` 默认 `$DSH_HOME/../.agents`。源码里一律用 `os.homedir()` 拼接，不依赖 shell 展开 `~`。

## 人格块

SOUL 源按顺序尝试：`$DSH_HOME/SOUL.md` → `$DSH_AGENTS_HOME/SOUL.md`（通常是 `~/.agents/SOUL.md`），同步到 `$DSH_AGENTS_HOME/AGENTS.md` 的标记块：

```md
<!-- dsh-caduceus:soul:start -->
（SOUL.md 正文，CRLF 归一化为 LF）
<!-- dsh-caduceus:soul:end -->
```

- **只替换两个标记之间的内容**，标记外一个字节不动；
- 幂等：内容相同不写盘；
- 两个 SOUL 源都不存在时**不建文件、不报错**，只记一行 info `persona source missing`；
- 目标文件损坏时返回状态（`malformed`），不抛错，不破坏原文件；
- 建议正文 ≤ 2 KB（设计稿 §4 的指令预算），超限只告警。

## 与 dsh 的版本关系

`peerDependencies` 把 `@deepseek-ai/dsh-*` 钉在 **0.2.1-rc.2**（运行时由 dsh 安装提供，不打进本包）；`@deepseek-ai/cordis` 钉 `~4.0.5`、`@deepseek-ai/schemastery` 钉 `^3.18.1` —— 这两个包走独立版本线，不随 dsh 0.2.1-rc.2 发版，是不对齐 0.2.1-rc.2 的例外。飞书 SDK `@larksuiteoapi/node-sdk ^1.76.0` 是本包的运行时依赖。

## 边界

- 不改 dsh 安装目录、不改任何 preset；
- 不写 `$DSH_HOME` 下的 sessions / storages / feishu 生产数据；
- 不启动、停止、重启任何服务（服务生命周期由宿主统一管理）；
- 单测一律使用 `mkdtemp` 临时目录与注入式假实现，不读真实 `~/.dsh`、不需要飞书凭据。
