# 第四十七刀：/help 双段 + 自有 /export

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 背景

- dsh 原生命令（`/compact` `/goal` `/plan` `/permission` `/feedback`）本来就能从
  `runHarnessCommand` 透传，但 `/help` 没列出来；
- `/export` 是 Web 专用（服务只返回 REQUESTED，ZIP 由浏览器下载），IM 必须自己导出；
- `WEB_ONLY_DENYLIST` 原本拒绝 `/export`。

## 1. 实现

### 1.1 /help 双段

```
dsh-caduceus 命令：
/new — ...
...
dsh 原生命令（透传）：
/compact — 压缩当前会话上下文
/goal — 查看/管理当前目标
/plan — 查看/切换计划模式
/permission — 查看/切换审批策略
/feedback — 提交反馈
其他 /命令 与普通消息原样交给 dsh。
```

### 1.2 /export

- `COMMAND_NAMES`/SPECS 增加 `export`，支持 `/export` 与 `/export --json`；
- 从 `WEB_ONLY_DENYLIST` 移除 export（denylist 现为空，保留 seam）；
- 数据：优先 `exportProvider`（index 用 `ctx.get('sessionQuery').readSession()` 转成
  events → messages + rawJsonl），否则 `readSessionLogFile()` 直读
  `$DSH_HOME/sessions/**/<sessionId>/session.v*.jsonl[.zstd]`；
  zstd 用 Node `zlib.zstdDecompressSync`，不可用则明确报错；
- markdown：头部 sessionId/标题/导出时间/消息数，逐条
  `## user` / `## assistant` / `## tool: <name>`，正文用代码块包裹；
- JSONL：`/export --json` 写未压缩 `.jsonl`；
- 单文件上限 5MB，超出截断并写 `> 导出内容超过 5MB，已截断。`；
- 写到会话 cwd：`.caduceus-export-<sessionId前8>-<时间戳>.md|.jsonl`；
- 回复 `MEDIA:<绝对路径>` + 一句说明，并显式调用现有 `#sendOutboundMedia`
  把文件发进当前会话/话题；
- 无会话/无日志/写入失败/读取失败 → 明确文本回复，不静默。

### 1.3 顺带

- `scripts/smoke.mjs` 更新 13 命令与 `/export` 解析，并把 `/new` 的回复断言改为
  `sendText`（0.7.1 私聊直发后的行为）。
- 版本 0.8.0。

## 2. 测试

原有 308 例保留，新增 5 例，共 **313** 全绿：

- `/help` 两段 + 5 条 dsh 原生命令；
- markdown 导出：头部、user/assistant/tool 块、回复 MEDIA、文件真实存在、上传一次；
- `--json` 写 `.jsonl` 并回复 MEDIA；
- 无日志 → 「本会话没有可导出的日志」，不写文件；
- 超过 5MB → 文件 ≤5MB 且注明截断。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | /help | 两段都在，5 条 dsh 原生命令可见 |
| 2 | /export | 回复 MEDIA + 说明，话题内收到 .md 文件 |
| 3 | 内容 | 文件含标题、消息数、user/assistant/tool 块 |
| 4 | --json | 收到 .jsonl 文件 |
| 5 | 无日志 | 明确回复“没有可导出的日志” |
| 6 | 超大 | 文件 ≤5MB 且注明已截断 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.8.0。
- 优先走 sessionQuery；服务不可用时直读磁盘日志；两者都失败会明确报错。
- 导出文件写会话 cwd；MEDIA 链沿用既有发送/话题逻辑。
- `docs/DESIGN.md` 未触碰；profile 未改。
