# dsh-caduceus

[English](README.md) / **中文**

[![npm version](https://img.shields.io/npm/v/dsh-caduceus.svg)](https://www.npmjs.com/package/dsh-caduceus)
[![GitHub stars](https://img.shields.io/github/stars/ArtomYuan/dsh-caduceus.svg?style=social)](https://github.com/ArtomYuan/dsh-caduceus)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**在飞书/Lark 里像用 agent 一样用 DeepSeek Harness——一个话题一个会话，标题可见，每回合一张卡。**

> 作用域：引擎仍是 dsh。agent loop、工具、沙箱、skills 都不变；本包只提供会话语义与聊天界面。

## What you get（能拿到什么）

- **一个 scope 一个会话** — 私聊、话题、普通群按发送者隔离。
- **标题可见** — 由第一条 prompt 生成，显示在回合卡上。
- **每回合一张卡** — 状态与答案在同一张卡里，原地编辑；终稿不再另发一条消息。
- **14 条命令** — `/new`、`/sessions`、`/rename`、`/resume`、`/adopt`、`/status`、`/stop`、`/doctor`、`/selfcheck`、`/persona`、`/whoami`、`/export`、`/permission`、`/help`。
- **人格** — `SOUL.md` 同步到 `AGENTS.md` 的标记块，启动时自动执行。
- **可观测性** — 两阶段自检、`/doctor`、对话内的降级提示。

## Looks like（长什么样）

```text
飞书会话 · 过程
会话：重构登录流程 · **运行中** · 步数 4 · 工具 3 · 已运行 12s
最近：bash
（正文在这张卡里滚动；收尾时同一张卡定格为「完成」）
```

这是文本示意，不是截图。收尾时卡内显示终态与完整答案；降级（preset 未挂载）时状态行会标 `（preset 未挂载）`。

## Requirements（前置要求）

| 要求 | 版本 / 说明 |
|:--|:--|
| dsh | `>=0.2.1-rc.2` |
| Node.js | `>=22.13` |
| pnpm | `>=10`（实测 11） |
| 飞书/Lark 应用 | 一个应用同一时间只能有**一路长连接**消费者 |

## Install（安装）

1. 装包（必须带 build flag，说明见下）：

   ```bash
   dsh plugin --profile web add dsh-caduceus --allow-build=protobufjs
   ```

2. 在 profile 的 `cordis.patch.yml` 里，给 `caduceus-gateway` 这一行填飞书凭证
   （`appId` / `appSecret`，或用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。

3. 由宿主侧重启 dsh。日志里应出现 `feishu long connection started`。

> **pnpm ≥10 注意**：`protobufjs` 是飞书 SDK 的传递依赖；pnpm ≥10 默认不执行依赖包的安装/构建脚本。
> 必须用**等号**形式 `--allow-build=protobufjs`；空格形式（`--allow-build protobufjs`）会报
> `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`。不带 flag 会以
> `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: protobufjs@7.6.6` 失败。
> 也可以在 profile 的 `pnpm-workspace.yaml` 里预先放行：

```yaml
onlyBuiltDependencies:
  - protobufjs
```

> 安装后用 `dsh --profile web --dump-config | grep dsh-caduceus` 确认——应至少 2 行。

## Configure（配置）

| 配置 | 默认 | 说明 |
|:--|:--|:--|
| `appId` / `appSecret` | — | 飞书应用凭证；也可用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| `defaultCwd` | 当前进程 cwd | 新建会话的工作目录 |
| `groupSessionsPerUser` | `true` | 普通群按发送者隔离会话；话题不受影响 |
| `busyMode` | `queue` | 忙碌时投递：`queue` / `steer` / `interrupt` |
| `cardThrottleMs` | `400` | 过程卡 patch 节流（毫秒） |
| `personaAutoSync` | `true` | 启动时把 SOUL 同步到 `$DSH_HOME/AGENTS.md` |
| `agentPreset` | `standard` | 新会话挂载的 dsh agent preset |
| `logLevel` | `info` | 文件日志级别：`info` / `debug` |
| `approvalCard` | `true` | 发交互审批卡（允许一次 / 拒绝） |
| `questionCard` | `true` | 发交互选项卡；单选且 ≤4 个选项时显示按钮 |
| `interactiveTimeoutMs` | `300000` | 审批/选项卡等待多久后过期 |
| `approvalPolicy` | 未设置 | 可选覆盖：`ask` / `never`；不设置则完全不动 dsh 的审批策略 |
| `reactions` | `true` | 消息表情反馈：处理中 `OnIt`，结束 `DONE`/`CROSS_MARK` |
| `reactionOnStart` | `OnIt` | 收到用户消息时添加的表情 |
| `reactionOnDone` | `DONE` | 回合完成时添加的表情 |
| `reactionOnFail` | `CROSS_MARK` | 回合出错/中断时添加的表情（失败退回 `THINKING`） |
| `gateRequireBotIdentity` | `true` | bot open id 未知时群 @ 门禁 fail-closed（false 恢复旧放行） |
| `images` | `true` | 接收图片消息并作为附件交给 agent |
| `files` | `true` | 接收文件消息（附件服务或落到 cwd） |
| `maxAttachmentBytes` | `20971520` | 单个附件下载上限（20 MiB） |
| `sendMedia` | `true` | 把 agent 的 `MEDIA:/path` 产物发回飞书 |
| `maxSendFileBytes` | `31457280` | 发送文件上限（30 MiB） |
| `maxSendImageBytes` | `10485760` | 发送图片上限（10 MiB） |
| `mediaRoots` | `[]` | 允许发送的目录（空=会话 cwd） |
| `admins` | `[]` | 管理员 open_id 白名单；空=关闭访问控制 |

## 命令

| 命令 | 说明 |
|:--|:--|
| `/new` | 立即创建新会话；旧会话保留 |
| `/sessions [--all]` | 列出当前会话，或本聊天的全部会话 |
| `/rename <标题>` | 重命名当前会话 |
| `/resume [id\|尾号]` | 恢复上一条，或按完整 id / ≥8 位尾号切换 |
| `/adopt <id\|尾号>` | 把无归属的历史会话收养到当前 scope |
| `/status` | 当前会话状态 + 自检摘要 |
| `/stop` | 中断正在运行的一轮 |
| `/doctor [--json]` | 体检报告：运行时 / 飞书 / 人格 / 会话 / 存储 / 版本 |
| `/selfcheck` | 立即重跑两阶段自检并输出逐项明细 |
| `/persona [show\|sync]` | 查看或同步 SOUL 人格块 |
| `/whoami` | 显示你的 open_id、当前会话与身份 |
| `/export [--json]` | 把当前会话导出为 markdown 或原始 JSONL 并发回文件 |
| `/permission [档位]` | 查看或切换当前会话权限档位（中文） |
| `/help` | 命令表 |

## Troubleshooting（故障排查）

- **日志里没有 `feishu long connection started`**：先发 `/doctor`，再看文件日志 `$DSH_HOME/caduceus/caduceus.log`。
- **`/doctor`**：逐项显示运行时、飞书、人格、会话、存储状态；`/doctor --json` 可给脚本或求助对象。
- **对话内提示**：自检失败会发 `⚠ 自检异常 …（详情 /doctor）`；恢复会发 `✓ 自检已恢复`。
- **`preset:applied` 失败**：agent 没挂 preset，等于没工具、没人格；检查 `agentPreset` 与 `agentPresets` 服务。
- **`persona:fresh` 失败**：`SOUL.md` 与 `$DSH_HOME/AGENTS.md` 的块不一致；发 `/persona sync` 或等下次启动自动同步。
- **安装报 `ERR_PNPM_IGNORED_BUILDS` / `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`**：见 Install 的 pnpm 说明。

## Limitations（限制）

- 一个飞书/Lark 应用只支持一路长连接消费者；不要在两个 dsh 实例里跑同一个应用。
- 命令回合（`/doctor`、`/status`、`/sessions` 等）不经过 agent，工具数在发正常消息前可能显示 `pending`。
- 人格投影目标是 `$DSH_HOME/AGENTS.md`；旧位置 `$DSH_AGENTS_HOME/AGENTS.md` 的块只会被提示，不会自动删除。
- 文件日志 5 MB 轮转，保留 3 份。
- 没有独立的 Web UI 安装向导；安装走 dsh CLI。

## Docs（文档）

- [docs/DESIGN.md](docs/DESIGN.md) — 设计与界面语义
- [docs/VERIFY.md](docs/VERIFY.md) — 隔离 profile 验证步骤
- [docs/](docs/) — 各刀记录（`SLICE*.md`）

## License（许可）

[MIT](LICENSE) © 2026 ArtomYuan
