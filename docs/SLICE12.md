# 第十二刀：会话归属（meta.caduceus）+ 启动补录 + `/adopt`

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh`（测试全部 mkdtemp）。

## 0. 背景（宿主分析）

会话 id 是 `feishu-<epoch_ms>`，不含 chatId；dsh session meta 也没有归属字段。history 一丢，会话就永远反查不到（例：`feishu-1793463503786` 磁盘上存在，但 `/resume` 连全 id 都匹配不到——候选只来自 map + history）。

## 1. 改动

### 1.1 写入归属

- 两处 `agents.create`（首条消息建会话、`/new` 物化）统一走 `Bridge#createAgent`，`meta` 为：
  ```json
  { "cwd": "...", "caduceus": { "chatId": "oc_...", "scopeKey": "...", "kind": "p2p|topic|group-user" } }
  ```
  保留 dsh 自己的 `cwd` 字段；remint 异常路径同样带 meta 并写归属。
- **实际持久来源是 sidecar**：`<DSH_HOME>/caduceus/owners/<sessionId>.json`。原因：核查 dsh 0.2.1-rc.2 源码，`SessionStore.prepare` 从已知 meta 字段重建 header，未知的 `meta.caduceus` 会被丢弃；因此 create 仍按契约带 meta，同时由本包原子写 sidecar，保证重启可读。
- 写 sidecar 失败只 WARN，不影响会话创建。

### 1.2 启动补录（幂等、只读扫描）

`src/backfill.ts#backfillSessionOwnership(store, {logger})`：

1. 扫描 `<DSH_HOME>/sessions/<bucket>/feishu-*/`（只读，不建会话/agent）；
2. 每个会话读归属：先 `owners/<id>.json` 的 `caduceus`，再读会话目录内 `caduceus-owner.json` / 明文 `*.jsonl` 前 20 行的 `meta.caduceus`（`session/created`/plugin record 形状均兼容；压缩 `.zstd` 不解码）；
3. 无归属 → `skipped++`；有归属且该 id 不在对应 scopeKey 的 history → `SessionStore.appendHistory()`（新在前，保持 current 不变，≤50）→ `adopted++`；
4. 启动日志一行 `backfill: scanned=N adopted=M skipped=K`。

`index.ts` 在 session-map load 之后、凭据检查之前调用（无凭据/空闲模式也会补录）。第二次启动 adopted=0（幂等）。

### 1.3 `/adopt <全 id|≥8 位尾号>`

- 候选 = 本 chat 所有 scope 的当前 + history + 磁盘上发现的 `feishu-*` 会话；
- 完整 id 优先，否则 ≥8 位不歧义尾号；歧义列候选（≤5，标注 scope 或「未归属」）；零命中给提示；
- 若命中的 id 已在**其他 scope** 下 → 明确提示位置并拒绝重复收养；
- 否则 `#switchSession`：resume 成 live agent → `SessionStore.set()` 成为当前并把该 id 提到 history 首位（旧 current 保留）；history 仍受 50 上限。
- 对存量孤儿（如 `63503786`）：磁盘扫描命中后即可收养，无需它先有 ownership sidecar。

## 2. 测试

- 原有 172 例全部保留，新增 6 例，共 **178 例全绿**：
  - `backfill：扫描 3 条会话（2 带 meta、1 不带）→ adopted=2/skipped=1，且幂等`（含 `backfill:` 日志断言）；
  - `ownership：写入/读取 sidecar，路径安全且内容可校验`；
  - `create 带 meta.caduceus 归属（p2p / topic / group-user），并写 ownership sidecar`；
  - `/adopt：磁盘孤儿命中 → 加入 history 并设为当前`；
  - `/adopt：歧义列候选、零命中、已在其他 scope 下都给提示`；
  - `/adopt` 解析（usage/自有命令列表）。
- 所有路径注入 mkdtemp：bridge 的 `ownershipDir`、backfill 的 `root`/`ownership.dir`，不碰真实 `~/.dsh`；smoke 也使用临时 ownership 目录。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 启动补录日志 | 重启后文件日志出现 `backfill: scanned=N adopted=M skipped=K`；再次重启 adopted=0 |
| 2 | history 落盘 | session-map 对应 scopeKey 的 `history` 出现旧 id（如 `feishu-1793463503786`），当前 id 不被改 |
| 3 | 旧会话可达 | `/sessions --all` 能列出该 id；`/resume 63503786` 成功；重启后仍成功 |
| 4 | 归属 sidecar | `$DSH_HOME/caduceus/owners/<新会话 id>.json` 存在且 `caduceus` 三字段正确 |
| 5 | create meta | 新会话创建时假/真链路 meta 带 `{cwd, caduceus}`；dsh 仍正常创建（未知字段被忽略不报错） |
| 6 | `/adopt` 抢孤儿 | `/adopt 63503786` → 「已收养会话」，随后 `/status`/`/rename` 均作用于该 id |
| 7 | `/adopt` 边界 | 已在别 scope 的 id → 「已在其他 scope 下」；同尾号两条 → 候选；随机尾号 → 「没找到可收养的会话」 |
| 8 | 上限与回归 | 收养后 history ≤50；`/new`、`/rename`、标题、`/status`、门禁、日志均不回归 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- **dsh 会丢弃未知 session meta 字段**：本包用 caduceus 自己的 sidecar 作为实际持久层；若未来 dsh 支持透传 meta，可无缝切换为直接读 header。
- 存量孤儿不会自动归属（没有可读归属信息），需用户 `/adopt`；补录只收编**有归属**的会话。
- 压缩 `.jsonl.zstd` 不解析（sidecar 覆盖本包创建的会话）；未来如需从历史压缩日志恢复归属，再引入 zstd 解码。
