# 第十刀：修复 `/new` 的幽灵 id（立即物化会话）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh` 数据。

## 0. 真机证据（2026-11-01 00:18，伊冯私聊）

- 23:33 `/new` → 回「已新建会话 `feishu-1793460837083`」；
- 00:18 `/rename 测试标题` → 日志 `WARN resume failed for feishu-1793460837083; reminting: session "feishu-1793460837083" not found`，随后新铸 `feishu-1793463503786`；
- 结果：`/new` 报给用户的 id 与真正被改名的会话 id 不一致，旧 id 从未落盘（幽灵条目）。

**根因**：`/new` 只在 session-map 写了一个未来要用的 id，并未真正创建会话；下一次需要 live session（rename/status 等）时 resume 失败，就 remint 一个全新 id。

## 1. 改动

### 1.1 `/new` 立即物化会话

`Bridge#runOwned('new')`：

1. 先铸新 id，并读取当前 cwd（`sessionMap.getCwd ?? defaultCwd`）；
2. **先调用 `agents.create({ sessionId: fresh, meta: { cwd } })`**（与普通回合一致的 meta）；
3. create 成功后才提交状态：写 session-map（同一 id）、更新 state、`bindSession`（id 与 agent.session.id）、清理卡片/标题、回复 `已新建会话 <短 id>`；
4. create 失败：回 `新建会话失败：<原因>`，**不写 session-map**、不动旧会话（旧会话仍是当前）。

因此 `/new` 返回给用户的短 id 就是真实被创建/后续被 rename 的会话 id；正常流程不再触发 remint。

### 1.2 remint 降级为异常路径（日志可诊断）

`#resolveAgent` 的 resume 失败分支保留（用于真正损坏/丢失的会话），但：

- 先生成新 id，再以 WARN 记录：`resume failed for <old>: <err>; old id never landed, reminting (old=<old>, new=<new>)`；
- 明确写出两个 id，便于排查「报给用户的 id 与真正 id 不一致」的情况。

### 1.3 `/sessions` 标记幽灵条目

- 新增 `src/session-files.ts#hasSessionLog(sessionId)`：只读扫描 `<DSH_HOME>/sessions/<bucket>/<sessionId>/` 下的 `*.jsonl*` 生成文件（限制 safe id、缺失/不可读一律 false，不抛错）。
- `BridgeOptions.sessionExists?: (id) => boolean`；`index.ts` 注入真实文件系统检查；测试默认 `true`。
- 判定：`agents.get(id)` 存在（live）或磁盘有日志 → 已落地；否则在 `/sessions` 与 `/sessions --all` 行末追加 **`（未落地）`**（仍显示，便于用 `/resume` 排查，不伪装成正常会话）。
- 当前 live 会话永远不会被误标（即使文件尚未刷盘）。

## 2. 测试

- 原有 160 例全部保留，新增 5 例，共 **165 例全绿**：
  - `/new 立即物化会话：create 调用与 map 写入同一个 id，回复短 id`（并断言随后 `/rename` 不再触发 resume failed）；
  - `/new 物化失败：不写 map、回错误文案、保留旧会话`；
  - `/sessions：map 里有但磁盘无日志的条目标「（未落地）」`（live 当前行不被标记）；
  - `hasSessionLog：存在 session.v*.jsonl* 视为已落地`；
  - `hasSessionLog：目录存在但无 JSONL 文件 / 无目录 / 非法 id 都视为未落地`。
  - 既有 `resume 失败时重铸新 session` 用例增强断言：WARN 同时含旧 id、新 id 与 `never landed` 文案（未删除/弱化）。
- 全部注入式（假 transport/agents/clock、mkdtemp），不碰真飞书与真 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | `/new` id 稳定 | `/new` 记下回复的短 id → 立即 `/rename 测试标题`：应成功，日志不再出现 `resume failed ...; reminting`，且 `session/title` 属于同一个完整 id |
| 2 | `/new` 后立即可用 | `/new` 后直接 `/status`、`/rename`、发消息：全部作用于新 id，无 remint WARN |
| 3 | 会话真正落盘 | `find $DSH_HOME/sessions -path "*<完整 id>*" -name "session.v*.jsonl*"` 有结果 |
| 4 | 旧幽灵条目可见 | 升级前遗留的幽灵 id 在 `/sessions --all` 行末出现 `（未落地）`；正常历史会话不出现该标记 |
| 5 | 创建失败路径 | 真机难以主动触发；观察磁盘/权限异常时 `/new` 只回错误、session-map 不新增条目、旧会话仍可用 |
| 6 | remint 异常兜底 | 人为把 map 指向一个不存在的 id 后发消息：日志 WARN 含 old/new 两个 id，chat 不卡死 |
| 7 | 重启兼容 | 重启后 `/sessions` 对真实存在的会话不误标 `（未落地）`（live 与磁盘检查都覆盖） |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 幽灵检测是只读目录扫描：大 DSH_HOME 下 `/sessions` 会多几次 readdir，但只影响手动命令，不在消息路径上。
- 已存在的旧幽灵 session-map 条目不会被自动删除（保留数据），只在列表中标 `（未落地）`；需要时可手工清理该键。
