# 第十九刀：人格启动自动同步

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 背景

人格是「源 + 投影」：`~/.agents/SOUL.md`（源）→ `~/.dsh/AGENTS.md` 的标记块（投影）。
上一刀修正了投影目标，但目前只能手动 `/persona sync`；忘记发就漂移，prompt 里的人格过期。

## 1. 改动

### 1.1 启动自动同步（一次）

- 新增 `src/persona/auto-sync.ts#autoSyncPersona()`：
  - `enabled === false` → 直接返回（零调用）；
  - 调一次 `syncSoul()`（可注入 seam 供测试），目标默认 `<DSH_HOME>/AGENTS.md`；
  - 结果日志：
    - `created`/`updated`/`unchanged` → info
      `persona: synced soulBytes=<n> agentsBytes=<n> status=<status>`；
    - `missing` → info `persona: source missing; skipped`（**不创建空文件**）；
    - `malformed` → warn `persona: sync skipped (malformed)`；
    - `invalid` → warn `persona: sync skipped (invalid)`；
  - 任何异常 catch 后只记一行 warn `persona auto-sync failed: <reason>`，绝不阻断启动。
- `src/index.ts` 接线：在 `ctx.effect` 里先 `await personaAutoSync()` 再
  `await transport.start()`，保证同步一定早于第一条入站消息；
  - 无飞书凭据的 idle 模式也会触发一次（fire-and-forget），保持投影新鲜。

### 1.2 幂等（未变不写盘）

- 复用 `syncSoul()` 的 upsert：目标块已匹配 SOUL 时返回 `unchanged` 且**在写盘前返回**，
  文件 mtime/字节均不变；测试用 `utimesSync` 伪造旧 mtime，二次调用后断言 mtime 未变。

### 1.3 配置

- `GatewayConfig.personaAutoSync?: boolean`，默认 `true`（`DEFAULT_PERSONA_AUTO_SYNC`）；
  `false` 时 `autoSyncPersona` 直接返回，零调用。

## 2. 测试

- 原有 188 例全部保留，新增 8 例，共 **196 例全绿**：
  - `autoSyncPersona：首次调用 sync 一次、写 DSH_HOME/AGENTS.md 并记 synced`；
  - `autoSyncPersona：内容未变 → status=unchanged 且不写盘（mtime 不变）`；
  - `autoSyncPersona：源缺失 → 不创建 DSH_HOME/AGENTS.md，记 source missing`；
  - `autoSyncPersona：目标标记损坏 → 不写、warn、启动继续`；
  - `autoSyncPersona：personaAutoSync=false → 零调用`；
  - `autoSyncPersona：异常被捕获，只记一行 warn，不抛错`；
  - `autoSyncPersona 保留块外内容（复用既有 upsert 语义）`；
  - config：`personaAutoSync` 默认 true / 显式 false。
- smoke 增加自动同步冒烟：临时 DSH_HOME 放 SOUL → 自动写入 AGENTS.md 并产生 `persona: synced` 日志。
- 全部注入式（mkdtemp、注入 env/logger/sync seam），不碰真实 `~/.dsh` / `~/.agents`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 启动日志 | 重启后文件日志出现 `persona: synced soulBytes=… agentsBytes=… status=created|updated|unchanged` |
| 2 | 投影正确 | `$DSH_HOME/AGENTS.md` 内出现最新 soul block；重启后模型人格生效（不再需要手动 `/persona sync`） |
| 3 | 幂等 | 不改 SOUL 再重启一次：日志 status=unchanged，`AGENTS.md` mtime 不变 |
| 4 | 源缺失 | 临时移走所有 SOUL 源后重启：日志 `persona: source missing; skipped`，不创建空 `AGENTS.md` |
| 5 | malformed | 人为把 `$DSH_HOME/AGENTS.md` 的标记改坏：启动日志 `persona: sync skipped (malformed)`，文件不动，飞书仍正常启动 |
| 6 | 开关 | 配置 `personaAutoSync: false` 重启：无同步日志、无写盘 |
| 7 | 顺序 | 同步发生在长连接启动前（日志顺序 persona 行在 feishu long connection started 之前） |
| 8 | 手动命令 | `/persona status` / `/persona sync` 行为不变，目标路径仍为 `$DSH_HOME/AGENTS.md` |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 自动同步只处理投影，不迁移旧 `~/.agents/AGENTS.md` 中的遗留块（仍只提示可删）。
- 同步发生在 transport.start 之前；若 SOUL 源极大，启动会多等待一次文件读写（毫秒级）。
- 异常路径只记 warn，不重试；下一次重启会再次尝试。
