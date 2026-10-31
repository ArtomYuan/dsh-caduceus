# dsh-caduceus

> 给 dsh 套一层 Hermes Agent 风格的飞书外壳：一个话题一个会话、SOUL 人格块、`/new` `/sessions` `/resume` 等命令、卡片过程与终稿。
> 名字取赫尔墨斯的**双蛇杖**（caduceus）——传令之权，不是神名；设计受 Hermes Agent 的网关思路启发。

**状态：第一刀（v0.1 骨架）。** 本刀交付项目骨架、四个纯逻辑模块与单测；**飞书长连接、agent 桥接、卡片渲染接线尚未实现**，两个 cordis entry 目前是可加载的空壳。设计稿见 [docs/DESIGN.md](docs/DESIGN.md)，验证手册见 [docs/VERIFY.md](docs/VERIFY.md)。

## 目录结构

```
dsh-caduceus/
├─ package.json          # dsh.bundle.patch → cordis.patch.yml；peer 由 dsh 运行时提供
├─ cordis.patch.yml      # 两条自有 entry + 官方标题 provider（三行 insert）
├─ tsconfig.json         # NodeNext · strict
├─ src/
│  ├─ index.ts           # entry: caduceus-gateway（第一刀空壳）
│  ├─ persona/index.ts   # entry: caduceus-persona（第一刀空壳）
│  ├─ home.ts            # DSH_HOME / DSH_AGENTS_HOME 路径解析（不展开 ~）
│  ├─ atomic-write.ts    # 先写 .tmp 再 rename
│  ├─ session-key.ts     # scopeKey + session-map.json v3（兼容 v1/v2）
│  ├─ persona/blocks.ts  # AGENTS.md 的 soul 块读写（只动标记之间）
│  ├─ commands/parse.ts  # 七条命令解析 + 未知透传
│  └─ render/truncate.ts # 卡片内容按 UTF-8 安全截断尾部约 8 KB
├─ test/                 # node:test（全部用 mkdtemp，不碰真实 ~/.dsh）
├─ scripts/smoke.mjs     # 构建产物冒烟（仅临时目录）
└─ docs/                 # 设计稿 + 验证手册
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

> 第一刀的 entry 可加载但不连飞书：命令解析与存储逻辑已就绪，真机聊天验收属第二刀。**不要在生产 profile 上直接试**；临时 profile 的复制、安装、三条冒烟命令与清理步骤见 [docs/VERIFY.md](docs/VERIFY.md)。

## 配置（第二刀落地，以下为设计口径）

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `appId` | — | 飞书应用 App ID；可用环境变量 `FEISHU_APP_ID` 兜底 |
| `appSecret` | — | 飞书应用 App Secret；可用环境变量 `FEISHU_APP_SECRET` 兜底 |
| `defaultCwd` | 进程 cwd | 新建会话的工作目录 |
| `allowedChats` | 空（全部） | 允许服务的 chat id 白名单 |
| `allowedUsers` | 空（全部） | 允许服务的用户 open_id 白名单 |
| `cardThrottleMs` | `400` | 过程卡片 patch 节流（5 QPS 的一半） |
| `busyMode` | `queue` | 忙时策略：`queue` → followup、`steer` → steer、`interrupt` → cancel+steer |

## 命令

| 命令 | 说明 |
|:--|:--|
| `/new` | 为当前聊天/话题新建会话，旧会话保留 |
| `/sessions` | 列出本聊天/话题的会话与标题 |
| `/rename <标题>` | 重命名当前会话的标题（标题非法时回一句人话） |
| `/resume [id]` | 恢复本聊天/话题的上一条或指定会话 |
| `/stop` | 中断当前正在运行的一轮 |
| `/persona [show\|sync]` | 查看或同步 SOUL 人格块 |
| `/help` | 显示命令表 |

其他 `/命令`（例如 `/compact`）与普通消息**原样透传**给 dsh 命令注册表 / agent，本包不拦。

## 存储

`$DSH_HOME/caduceus/session-map.json`，当前 **version 3**：

```json
{
  "version": 3,
  "entries": { "oc_xxx\u0000omt_yyy": { "sessionId": "feishu-1793313252045" } },
  "cwd": { "oc_xxx\u0000omt_yyy": "/home/artom/agent-workspace" }
}
```

- 键：`scopeKey = chatId + "\u0000" + threadId`；无话题时回落为 `chatId`。
- 旧格式可读：v2 是扁平 `{ "<scope key>": "feishu-<ts>" }`，v1 把这些字符串放在 `sessions` 下。**旧键原样保留、不批量改写**，下一次落盘才写成 v3。
- 写入是原子的：先写同目录 `.tmp`，再 `rename` 覆盖；权限 `0600`。
- 标题不落此表：唯一来源是 dsh 的 `sessionTitle.get(session)`。

`$DSH_HOME` 默认 `<用户 home>/.dsh`；`$DSH_AGENTS_HOME` 默认 `$DSH_HOME/../.agents`。源码里一律用 `os.homedir()` 拼接，不依赖 shell 展开 `~`。

## 人格块

SOUL 源默认 `$DSH_HOME/SOUL.md`，同步到 `$DSH_AGENTS_HOME/AGENTS.md` 的标记块：

```md
<!-- dsh-caduceus:soul:start -->
（SOUL.md 正文，CRLF 归一化为 LF）
<!-- dsh-caduceus:soul:end -->
```

- **只替换两个标记之间的内容**，标记外一个字节不动；
- 幂等：内容相同不写盘；
- SOUL 源缺失 / 目标文件损坏时返回状态（`missing` / `malformed`），不抛错，不破坏原文件；
- 建议正文 ≤ 2 KB（设计稿 §4 的指令预算），超限只告警。

## 与 dsh 的版本关系

`peerDependencies` 把 `@deepseek-ai/dsh-*` 钉在 **0.2.1-rc.2**（运行时由 dsh 安装提供，不打进本包）；`@deepseek-ai/cordis` 钉 `~4.0.5` —— cordis 走独立版本线，不随 dsh 0.2.1-rc.2 发版，这是唯一一条不对齐 0.2.1-rc.2 的例外。

## 边界

- 不改 dsh 安装目录、不改任何 preset；
- 不写 `$DSH_HOME` 下的 sessions / storages / feishu 生产数据；
- 不启动、停止、重启任何服务（服务生命周期由宿主统一管理）；
- 单测一律使用 `mkdtemp` 临时目录，不读真实 `~/.dsh`。
