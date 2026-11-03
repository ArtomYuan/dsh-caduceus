# dsh-caduceus 设计说明（当前实现）

本文只写设计、取舍与不变量，不复述 README 的安装与命令用法。

## 1. 定位与边界

dsh 没有“替换运行时”的扩展点，无法变成 Hermes Agent。本包只对齐外壳语义：
会话键、话题、人格投影、卡片交付、交互件、门禁与可观测。
agent loop、工具、沙箱、skills、模型路由仍由 dsh 提供；本包不重实现这些能力。
因此 dsh 能力边界就是本包的边界，UI 层不制造“另一个 agent”。

## 2. 会话键与隔离

scopeKey 是会话归属的唯一键：

- p2p：`chatId`（缺失时退回 senderOpenId）。
- 话题：`chatId + NUL + threadId`，话题内所有人共享同一会话。
- 普通群：`chatId + NUL + senderOpenId`（`groupSessionsPerUser` 默认 true）。
- `groupSessionsPerUser=false` 时普通群回到 `chatId` 共享会话；空 sender 也回到 chatId。

NUL 分隔保证 chatId/threadId/sender 之间的边界不歧义。话题身份只取
`message.thread_id`；`root_id` 只作诊断字段，不兼任话题，否则私聊会被误判为话题。

## 3. 交付形状：一回合一张卡

每个回合只有一张卡：过程状态与最终答案都在同一张卡里，收尾时原地 patch。
最终答案不另发消息；过程卡不复制答案。卡片承载上限 30KB（平台限制），
超长正文按 UTF-8 安全截断并注明省略量。

只有卡片编辑失败时，才把同一份内容降级为文本发送一次；这是唯一降级路径。
状态卡不单独存在；过程卡同时承担状态线与结果。

## 4. 存储与归属

`$DSH_HOME/caduceus/session-map.json` 保存 scopeKey → 会话：

- 版本 v5：每个键保存 `sessionId` 与有界 `history`（最近优先、去重，
  `history[0]` 通常就是当前 id）。
- 写入使用原子替换（临时文件 + rename），避免半写损坏。
- 旧格式（v2/v3/v4）仍可读：缺少 history 的条目以当前 id 为起点，下一次写入迁移。

会话归属写入 dsh session 的 `meta.caduceus = {chatId, scopeKey, kind}`；
kind 为 `p2p` / `topic` / `group-user`。运行时 dsh 会丢弃未知 meta，
所以另存 ownership sidecar 作为持久判据。

启动补录只认带 `meta.caduceus` 的会话；没有归属的旧会话不会自动归到某个 scope。
`/adopt` 是显式收养入口：把一条无归属会话写入当前 scope 的 map/history。

## 5. 人格投影

人格源按顺序查找：

1. `$DSH_HOME/SOUL.md`
2. `$DSH_AGENTS_HOME/SOUL.md`（通常 `~/.agents/SOUL.md`）

投影目标是 `$DSH_HOME/AGENTS.md` 中的一段标记块：

```text
<!-- dsh-caduceus:soul:start -->
…SOUL 正文…
<!-- dsh-caduceus:soul:end -->
```

dsh 的全局指令加载器读 `$DSH_HOME/AGENTS.md`，不展开 `@path` import；因此必须
把 SOUL 内联进该文件。块外字节不得改动：同步只替换两个标记之间的内容，
文件其余部分保持原样；源或目标异常时返回状态，不写坏文件。

## 6. 命令面

自有命令 15 条：`/new` `/sessions` `/rename` `/resume` `/adopt` `/selfcheck`
`/doctor` `/stop` `/status` `/persona` `/whoami` `/export` `/permission`
`/usage` `/help`。

自有命令之外的 slash 命令原样转交 dsh 命令注册表；`/help` 分“自有命令”和
“dsh 原生命令（透传）”两段。`/whoami` 用于身份自检：open_id、当前会话/话题、
管理员或访客。

## 7. 交互件

### 审批卡

dsh 的审批结果是封闭集合：`allowed-once` / `rejected` / `cancelled` /
`unavailable`，不扩展词表。卡内：

- 两个按钮：允许一次、拒绝；按钮 value 带请求 id、label、choice。
- 超时或 abort → `cancelled`；发卡失败 → `cancelled`（fail-closed），日志 ERROR。
- 非 owner 点击一律忽略，不 resolve、不回写。
- 卡片发送失败或服务缺失时不得放行。

### 选项卡

单问题且单选项 ≤4 时渲染按钮；否则文本卡提示回复文本。答案编码沿用 dsh：
按钮 → `selected:[label]`；自填 → `selected:[]` + `custom:"…"`。
`multiSelect` 当前只支持单选，卡片显式提示；空文本提交不 resolve，只提示。

### 权限卡

一张精简卡片：当前档位、用法、四个档位按钮。文案跟随 `lang`；当前档位按钮置灰。
档位名使用 dsh 官方词（Read Only / Workspace Write / Full access / Auto review(EXP)
及中文对应）。sandbox/approval 原始值不翻译。

### 停止按钮

运行中的过程卡底部显示「停止」，value `{action:'caduceus.turn.stop'}`；
非运行态不出现。点击后卡片显示“已停止当前回合。后台任务仍在运行，完成后结果会回来。”
同一 messageId 1 秒内只接受一次点击。

## 8. 停止语义

停止只 cancel 当前回合（`agent.cancel({kind:'user'})`），不 kill 后台任务。
dsh 的生产代码没有 `jobs.kill(` 调用者，跟随该语义。
后台任务完成后结果会作为 `user/message` 注入，并可能开启新回合；
本包不拦截也不假装杀掉它。

## 9. 指标

全部从会话日志事件聚合，不依赖内存 tracker：

- 轮数 = 最大 `data.turn`；步数 = `step/start` 累计。
- tok/s = 本回合输出 token / 本回合耗时秒；耗时 <1s 或缺失不显示。
- 累计 tok = 所有 `assistant/message` 的 `totalTokens` 之和；
  `>1e6` 显示 `7.9M`，`>1e3` 显示 `1.6k`。
- 缓存命中 = `cacheReadTokens / (cacheReadTokens + inputTokens)`，取整百分比；
  分母为 0 不显示。
- 上下文（detailed）= 上一回合 prompt token / 最近 `request/context.contextWindow`；
  任一缺失不显示。

`metrics: off|compact|detailed`，默认 compact。过程卡底部与 `/usage` 末尾使用同一行。
卡片缓存按 scope 保存全量指标：`turn/end` 后重算一次；回合中缓存全量 + 本回合增量；
冷缓存首次读日志，失败回退进程内事件并 warn 一次，不缓存失败。

## 10. 语言

`lang: zh|en|auto`，默认 zh。解析顺序：

1. 显式 `zh`/`en`：直接使用，不读 settings/env。
2. `auto`：settings 的 `locale.preference`。
3. 仍 auto：`LC_ALL` / `LANG`，仅当值以 `zh` 或 `en` 开头才采纳；
   `C`、`C.UTF-8`、`POSIX`、空都视为无偏好。
4. 最终回退 zh。

settings 读取失败不抛错、不缓存失败；显式配置永远优先于 settings。
权限面（权限卡、审批卡档位行、/status 权限行）跟随此语言；其他命令保持现有文案。

## 11. 导出

`/export` 自己生成文件，不依赖 Web 的 ZIP 下载：

- 数据优先 `sessionQuery.readSession(sessionId).events`，取不到时直读
  `$DSH_HOME/sessions/**` 的 JSONL/Zstd 日志。
- markdown：头部 sessionId/标题/导出时间/消息数，逐条 user/assistant/tool 块；
  `--json` 输出未压缩 JSONL。
- 单文件上限 5MB，超出截断并注明。
- 文件写入 `$DSH_HOME/caduceus/cache/exports/`，文件名
  `caduceus-<scopeKind>-<sessionTail8>-<yyyyMMdd-HHmmss>.<ext>`（不以点开头）。
- 启动确保目录存在，并清理 mtime 超过 `exportCacheMaxAgeHours`（默认 24）的文件；
  清理失败只 warn。
- 上传成功不删（交给启动清理）；上传失败保留文件并 warn 全路径。

## 12. 门禁与安全

- 私聊免 @。
- 普通群与话题必须 @ 机器人，命令也一样（没有命令豁免）。
- 机器人/应用消息一律丢弃（sender_type 优先），避免自触发。
- bot 身份未知时群 @ 门禁 fail-closed：带 mention 也拒绝；下一条群消息再重试身份，
  ERROR 每进程只打一次。`gateRequireBotIdentity=false` 可恢复旧放行行为。
- 管理员白名单 `admins`：空 = 访问控制关闭（启动 WARN）；非空只允许名单内 sender。
  非管理员只放行 `/help` 与 `/whoami`，其余回复“访客无执行权限”，不建会话、不调 agent、不发卡。
- 设计教训：给群消息“免 @”会把两个机器人都放进来抢答；门禁必须在接受消息前完成。

## 13. 平台硬限制

- 卡片实体编辑次数有上限（≤20 次）；过程卡节流在 400ms，避免耗尽。
- 一个飞书应用同时只能有一路长连接消费者。
- 话题名不可修改；话题内回复依赖 `reply_in_thread`。
- 审批词表只有 dsh 的四个结果，尤其 `allowed-once`，不能自定义“永久允许”。
- 卡片 patch 需要 `config.update_multi=true`；卡片 30KB、消息资源下载有大小上限。

## 14. 已知限制与待核

- `team/member` / `team/task` 事件只在 team preset 下产生；当前默认 preset
  `standard` 不触发，过程卡上的队友行不会出现。
- 审批的 `auto` 预设由官方插件 `dsh-experimental-auto-review` 提供；本包不实现
  自动审批，只渲染/转发 dsh 的结果。
- 权限的 `custom` 是派生状态：当前 sandbox/approval 旋钮组合不匹配任何预设时出现；
  本包不强行覆盖，只在卡片上解释并给出回到预设的指引。
- 指标上下文百分比依赖 `request/context.contextWindow`；该字段缺失时 detailed
  也只显示其余指标。
- 平台侧对表情/消息编辑的具体配额以飞书文档为准；本包只做节流与静默降级。
