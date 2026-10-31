# 第八刀：可见日志（文件日志 + 门禁/命令/会话键可追）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh` 数据。

## 0. 背景

真机证据：`logger.info('caduceus-gateway ready')` 在 journal 里零命中（21:05 之后无 caduceus 行），而同机另一个插件（dsh-hermes-link）的 info 行可见。结论：**不能依赖 `ctx.logger` 的可见性**，必须自己落文件，否则门禁丢消息、命令分发都不可观测。

## 1. 改动

### 1.1 文件日志 `src/file-logger.ts`

- 路径：`<DSH_HOME>/caduceus/caduceus.log`（`defaultLogPath()`；目录自动创建，文件 `0600`）。
- 行格式：`2026-10-31T21:07:35.123Z INFO  [caduceus] message`（UTC ISO 毫秒；level 左对齐 5 位）。
- 级别：`info`/`warn`/`error` 默认；`debug` 由 config `logLevel: 'debug'` 打开（`FileLogger` 的 `level`）。
- 轮转：写前检查文件大小，超过 `maxBytes`（默认 5 MB）→ 删除最旧、`.1→.2→.3` 顺移、当前文件→`.1`，最多保留 3 份（`maxFiles` 默认 3）。
- 与 `ctx.logger` 并存：`teeLoggers(console, file)`，任一 sink 失败不影响另一个，也不影响消息投递（写失败只经 `onError` 记 stderr 一次）。
- 时钟/阈值可注入，测试全用 mkdtemp。

### 1.2 门禁逐判定可追 `src/gate.ts`

`evaluateGate` 纯函数 + `formatGateLine`/`logGate`（info 级），每条一行：

| 判定 | 行前缀 |
|:--|:--|
| p2p 放行 | `gate accept: p2p` |
| 群 @ 放行 | `gate accept: mentioned` |
| 群无 @ | `gate drop: no-mention` |
| 机器人/应用 | `gate drop: bot-sender sender_type=app`（transport 层记录） |
| 不在白名单 chat | `gate drop: not-allowed-chat` |
| 不在白名单 user | `gate drop: not-allowed-user` |
| 空文本 | `gate drop: empty-text` |

每条都带 `chat=<前12> thread=<前12> sender=<前12>`。机器人消息在 `LarkFeishuApi` 归一化之前记录（bridge 永远看不到它们），桥接层的 5 类由 `Bridge#handleInbound` 统一记录。

### 1.3 命令分发可追

`Bridge#handleSlash` 记录：

- 自有命令：`command: /status`（去首尾空白后前 40 字符）；
- 未知命令透传：`command: unknown passthrough /xxx`；
- 解析失败（例如只发 `/`）：`command: parse-fail /`；
- denylist：`command: deny /export`。

### 1.4 启动行 + 会话键行

- `src/observability.ts#formatStartupLine`：`ready appId=cli_xxx…abcd defaultCwd=… groupSessionsPerUser=… throttle=… busyMode=…`；appId 只露前 7 + 后 4 位；**签名接受 appSecret 但从不打印**（测试用假 secret 断言任意 4 字符片段都不出现）。
- `formatScopeLine`：`scope: kind=p2p|topic|group-user|group-shared key=<前16位，NUL 显示为 \0> session=<前8位>`，在 agent create/resume 解析完成后记录。
- `index.ts` 启动时先建 FileLogger（即便凭据缺失也写日志），ready 行同时进控制台与文件。

## 2. 测试

- 原有 143 例全部保留，新增 12 例，共 **155 例全绿**：
  - 文件日志：行格式/0600、默认级别过滤与 debug 开关、轮转（小阈值）保留 3 份、默认阈值常量；
  - 门禁：六种判定各一条记录行 + 上下文前缀截断、bot id 未知退化规则；
  - 启动行：掩码格式、无 appSecret 片段、缺失 appId；
  - scope 行：四种 kind 与 key/session 前缀；
  - 桥接：命令分发三种行、scope 三 kind、门禁 accept/drop 行；
  - config：`logLevel` 默认/显式。
- 全部注入式（假 logger / 假 transport / 假 agents / mkdtemp），不碰真飞书与真 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 文件日志出现 | 启动后 `ls -l $DSH_HOME/caduceus/caduceus.log` 存在且 `0600`；`tail` 可见 `ready appId=…` 与门禁/命令行 |
| 2 | 启动行无 secret | 检查 ready 行只有 appId 掩码、无 appSecret 任意片段；可用 `grep` 验证 secret 不出现 |
| 3 | 门禁可追 | 群里不 @ 发消息：文件日志出现 `gate drop: no-mention chat=… thread=… sender=…`；p2p 出现 `gate accept: p2p`；@ 后出现 `gate accept: mentioned`；白名单/空文本各自对应行 |
| 4 | 机器人消息可追 | 应用/机器人事件：文件日志出现 `gate drop: bot-sender sender_type=app`，且不进会话 |
| 5 | 命令可追 | 发 `/status`、`/compact`、`/`：分别出现 `command: /status`、`command: unknown passthrough /compact`、`command: parse-fail /` |
| 6 | 会话键可追 | 收发消息后出现 `scope: kind=p2p|topic|group-user key=… session=…` |
| 7 | 轮转 | 长期运行或临时把阈值调小（`maxBytes`）后，确认 `.1/.2/.3` 出现且不超过 3 份（生产默认 5 MB，需长时间） |
| 8 | debug | 配置 `logLevel: 'debug'` 重启后出现 `DEBUG` 行；默认级别下不出现 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 文件日志为纯追加；轮转只在写前检查，5 MB 阈值在生产上需要长时间运行才触发（测试用小阈值覆盖）。
- 命令日志会记录命令原文前 40 字符（例如 `/rename` 的标题），属于操作审计需要；不记录消息正文。
- journal 可见性仍不可控（内核/宿主配置），本包不依赖它；文件日志是权威诊断来源。
