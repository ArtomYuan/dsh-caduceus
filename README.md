# dsh-caduceus

把 **DeepSeek Harness（dsh）** 接到 **飞书 / Lark** 的插件：一个话题一个会话，人格块自动同步，过程卡片承载状态与答案，并带 `/status`、`/doctor`、`/sessions` 等命令。

## 安装

先构建并打包（发布到 npm 后可直接装包名）：

```bash
npm install
npm run build
npm pack
```

两种安装方式：

```bash
# 1) npm 包（发布后）
dsh plugin --profile <profile> add dsh-caduceus

# 2) 本地 tgz
dsh plugin --profile <profile> add ./dsh-caduceus-0.1.0.tgz
```

安装/启用后由宿主统一重启 dsh；本包不控制服务。

## 配置

在 profile 的 bundle 配置里提供：

| 配置 | 默认 | 说明 |
|:--|:--|:--|
| `appId` / `appSecret` | — | 飞书应用凭证；也可用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| `defaultCwd` | 当前进程 cwd | 新建会话的工作目录 |
| `groupSessionsPerUser` | `true` | 普通群按发送者隔离会话；话题不受影响 |
| `busyMode` | `queue` | 群里忙时的投递：`queue` / `steer` / `interrupt` |
| `cardThrottleMs` | `400` | 过程卡 patch 节流（毫秒） |
| `personaAutoSync` | `true` | 启动时把 SOUL 同步到 `$DSH_HOME/AGENTS.md` |
| `agentPreset` | `standard` | 新会话挂载的 dsh agent preset |
| `logLevel` | `info` | 文件日志级别：`info` / `debug` |

人格：SOUL 源按 `$DSH_HOME/SOUL.md` → `$DSH_AGENTS_HOME/SOUL.md` 查找，投影到 `$DSH_HOME/AGENTS.md` 的标记块；命令见下。

## 命令

| 命令 | 说明 |
|:--|:--|
| `/new` | 立即创建新会话（旧会话保留） |
| `/sessions [--all]` | 列出当前会话或同聊天全部会话（含历史） |
| `/rename <标题>` | 重命名当前会话 |
| `/resume [id\|尾号]` | 恢复上一条或按完整 id / ≥8 位尾号切换 |
| `/adopt <id\|尾号>` | 把无归属的历史会话收养到当前 scope |
| `/selfcheck` | 立即重跑自检并输出逐项明细 |
| `/doctor [--json]` | 体检报告：运行时 / 飞书 / 人格 / 会话 / 存储 / 版本 |
| `/stop` | 中断正在运行的一轮 |
| `/status` | 当前会话状态与自检摘要 |
| `/persona [show\|sync]` | 查看或同步 SOUL 人格块 |
| `/help` | 命令表 |

## 故障排查

- 先发 `/doctor`：逐项看到 preset、工具数、人格投影、飞书连接、存储等状态；`/doctor --json` 可给脚本或他人排查。
- 文件日志：`$DSH_HOME/caduceus/caduceus.log`（自动轮转，默认保留 3 份）。
- 自检异常会同时在对话里发一条 `⚠ 自检异常 …（详情 /doctor）`；恢复后会发 `✓ 自检已恢复`。
- 常见项：`preset:applied` 失败 = agent 没挂 preset（无工具/无人格）；`persona:fresh` 失败 = SOUL 与 `AGENTS.md` 不一致，发 `/persona sync` 或重启等自动同步。

## 许可

MIT。见 [LICENSE](LICENSE)。
