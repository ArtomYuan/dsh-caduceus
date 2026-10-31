# 第十八刀：修正人格同步目标文件（`<DSH_HOME>/AGENTS.md`）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据（测试全部 mkdtemp）。

## 0. 问题与证据

- 设计/代码默认写到 `<DSH_AGENTS_HOME>/AGENTS.md`（= `~/.agents/AGENTS.md`）。
- 但当前 dsh 的 `@deepseek-ai/dsh-agent-instructions` 实际只读 **`$DSH_HOME/AGENTS.md`**
  （= `~/.dsh/AGENTS.md`）：`files.js#userGlobalDisplayPath() = ${dshHome}/AGENTS.md`，
  `render.js` 注释也写明 "the single user-global instruction file under $DSH_HOME"；
  `DSH_AGENTS_HOME` 只被 skill-filesystem 使用，与人格无关。
- 结果：写进 `~/.agents/AGENTS.md` 的人格块永远不会进 prompt。

## 1. 改动

### 1.1 默认目标改为 `<DSH_HOME>/AGENTS.md`

- `home.ts#defaultAgentsFile` → `join(dshHome(env), 'AGENTS.md')`。
- 新增 `legacyAgentsFile(env)` = `join(agentsHome(env), 'AGENTS.md')`，仅用于遗留检测。
- SOUL 源顺序不变：`<DSH_HOME>/SOUL.md` → `<DSH_AGENTS_HOME>/SOUL.md`。
- 文档注释同步：目标一律写 `$DSH_HOME/AGENTS.md`；`DSH_AGENTS_HOME` 只作为 SOUL 回退源/
  skill-filesystem/遗留位置出现。

### 1.2 `/persona status`（show）

- 所有分支都显示真实目标文件绝对路径与存在性：`目标：<abs path>（存在|不存在）`。
- present 分支保留人格块内容与字节数；absent/missing/malformed 也带目标行。

### 1.3 `/persona sync`

- 回显 `status=<status> soulBytes=<n> agentsBytes=<n>` + `目标：<abs path>（存在|不存在）`，
  外加 `SOUL：<实际源路径>`；成功/未变/缺失/非法均带目标行。

### 1.4 遗留块检测（只读）

- `findLegacySoulBlock()` 读取 `<DSH_AGENTS_HOME>/AGENTS.md`；若其中存在本插件标记块：
  - **不删文件、不修改**；
  - 日志 `warn`：`legacy soul block found at <path>; this file is no longer written by caduceus and may be deleted`；
  - `/persona sync` 与 `show` 文本追加 `⚠️ 发现遗留块在 <path>，可删（本插件不再写该位置）`。
- 目标与遗留路径相同（例如显式覆盖 DSH_AGENTS_HOME 与 DSH_HOME 相同）时跳过，避免自报。

## 2. 测试

- 原有 183 例全部保留（persona 默认路径相关断言更新到 `<DSH_HOME>/AGENTS.md`，覆盖意图不变），
  新增 5 例，共 **188 例全绿**：
  - `默认目标解析：<DSH_HOME>/AGENTS.md；旧位置仅作为 legacy 检测`；
  - `/persona sync 回显 status/soulBytes/agentsBytes 与真实目标路径`；
  - `/persona status 显示真实目标文件绝对路径与存在性`；
  - `遗留块检测：旧位置有标记块 → 提示但不动文件，目标写 DSH_HOME`（旧文件逐字节不变 + 日志警告）；
  - `syncSoul: 目标已存在时只替换块内，块外字节逐字节不变`（前后缀含 CRLF，最终文件逐字节等于
    `prefix + 新块 + suffix`）。
- 全部注入式（mkdtemp、注入 env/logger），不碰真实 `~/.dsh` / `~/.agents`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 目标路径 | `/persona status` 显示 `目标：~/.dsh/AGENTS.md（存在）`（绝对路径，非 `~/.agents`） |
| 2 | 人格进 prompt | `/persona sync` 后检查 `$DSH_HOME/AGENTS.md` 内出现 soul block；重启后模型人格生效 |
| 3 | 旧位置提示 | `~/.agents/AGENTS.md` 仍有旧块时，`/persona status`/`sync` 文本出现「发现遗留块…可删」；日志有 `legacy soul block found` |
| 4 | 不删旧文件 | 检查 `~/.agents/AGENTS.md` 字节未被本插件修改（可手工删除或留着） |
| 5 | 同步回显 | `/persona sync` 输出含 `status=… soulBytes=… agentsBytes=…` 与目标路径/存在性 |
| 6 | 块外不变 | 若 `$DSH_HOME/AGENTS.md` 已有其他指令，sync 后标记块外内容逐字节不变 |
| 7 | 源缺失 | 两个 SOUL 源都不存在时：不建/不改文件，仍显示目标路径与「未找到 SOUL 源」 |
| 8 | 幂等 | 连续 sync 第二次 `unchanged`，不写盘 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 旧 `~/.agents/AGENTS.md` 里的人格块**不会自动迁移**；如需清理，确认新目标有效后手工删除旧块。
- 已存在的 `<DSH_HOME>/AGENTS.md` 内的非本插件内容不会被触碰（只改标记块之间，逐字节测试覆盖）。
