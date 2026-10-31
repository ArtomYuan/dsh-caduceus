# 第二十刀（P0）：插件创建的 agent 必须挂 preset

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据（测试全部注入式）。

## 0. 根因与证据

真机硬证据：
1. 飞书会话头 `{"type":"session","id":"feishu-...","cwd":"..."}` —— **没有 `agentPreset`**；
   对照组 a2a 会话头有 `"agentPreset":"standard"`。
2. 该会话日志里 `agent-instructions` 出现 0 次（对照 28 次）。
3. 该会话回复卡片一直「工具 0」。
4. 同一份 `~/.dsh/AGENTS.md` 用 `dsh headless` 跑，人格正常。

根因：`Bridge#createAgent` 只调 `agents.create({ sessionId, meta: { cwd, caduceus } })`。
dsh 的 preset 不会自动挂：需要 `meta.agentPreset` + 在 `setup(agentCtx)` 里
`await agentPresets.mount(agentCtx, preset)`。

## 1. 改动

### 1.1 create 路径

`Bridge#createAgent` 现在传：

```ts
const agentPreset = this.#config.agentPreset ?? 'standard';
const { agent } = await this.#agents.create({
  sessionId,
  meta: { cwd, caduceus, agentPreset },
  setup: async (agentCtx) => { await this.#mountPreset(sessionId, agentCtx); },
});
```

- `agentPreset` 来自配置 `agentPreset`，默认 `standard`；启动日志新增一行
  `agent preset=<id>`。
- `meta.agentPreset` 是 dsh 写入 session 头的字段（dsh `SessionStore.prepare` 从
  `meta.agentPreset` 构造 header），因此修复后新建会话头应带 `agentPreset`。
- `/new`、首条消息建会话、remint 兜底都走同一个 `#createAgent`，不会漏。

### 1.2 resume 路径（老会话兼容）

- `ctx.sessions.get(sessionId).header.agentPreset` 通过 `sessionPresetLookup` 注入 Bridge：
  - header **已有** `agentPreset` → 不传 `setup`，**零 mount**；
  - header **没有**（本次修复前建的 legacy 会话）→ `setup` 里调用 `#mountPreset` 补挂一次。
- `#mountPreset` 内部再用 `agentPresets.composedPreset(agentCtx)` 判定：已有 composition 就跳过，
  避免 dsh 已在其它路径挂载时重复 mount。

### 1.3 mount 失败降级

- `#mountPreset` 全部 catch：`logger.warn("agent preset mount failed for <id> (<preset>): <reason>")`，
  会话保持可用；
- 失败会话 id 记入 `#presetFailures`，过程卡状态行末尾追加 `（preset 未挂载）`（终态卡同样）；
- `agentPresets` 服务缺失时：warn `agentPresets service unavailable; preset <id> not mounted`，
  继续运行（同样标记未挂载）。

### 1.4 依赖注入

- `ctx.get('agentPresets')` + `ctx.get('sessions')` 结构性适配后注入 Bridge（可选服务）：
  - `AgentPresetsLike { mount(ctx,id?), composedPreset(ctx) }`；
  - `sessionPresetLookup(sessionId)` 读 session header。
- `AgentsLike.create/resume` 的 seam 增加 `setup`，index 适配层原样透传给 dsh。

## 2. 测试

- 原有 196 例全部保留，新增 9 例，共 **205 例全绿**：
  - `create：meta.agentPreset=standard 且 setup 里 mount 一次`；
  - `resume 已有 preset：composedPreset 命中 → 不再 mount`；
  - `resume 会话头已有 agentPreset：不传 setup，mount 零调用`；
  - `legacy resume（无 preset 头）：setup 里 mount 一次`；
  - `mount 抛错：会话仍可用，warn 日志，状态行标「preset 未挂载」`；
  - `agentPreset 配置为 other：meta 与 mount 都用 other`；
  - `agentPresets 服务缺失：warn 并继续，状态行标记未挂载`；
  - `resume 旧会话 remint 时新会话也带 preset 并 mount`；
  - config：`agentPreset` 默认 standard / 显式 other。
- smoke：假 agents 记录 create meta 并断言 `agentPreset=standard`、mountCalls=['standard']，
  并把 dsh 会从 meta 投影出的 session header 写入临时文件断言 `agentPreset=standard`。
- 全部注入式（假 agents/presets、mkdtemp），不碰真飞书与真实 `~/.dsh`。

## 3. 会话头证据（dsh 行为）

- dsh `SessionStore.prepare()` 的 header 构造包含
  `...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }`，
  所以插件传 `meta.agentPreset` 后，新建会话的 session header 会写该字段。
- smoke 用临时目录把 create meta 投影为 header JSON 并断言：
  `{"type":"session","id":"...","cwd":"...","agentPreset":"standard"}`。
- 真实 session 文件（`$DSH_HOME/sessions/.../session.v*.jsonl*`）需重启后由真机确认；
  本仓库测试不触碰真实 `~/.dsh`。

## 4. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 新建会话头 | `/new` 后查看新 session 文件头：应出现 `"agentPreset":"standard"` |
| 2 | 人格生效 | 新对话问「你是谁」：应带大肥鱼人格；不再是默认助手 |
| 3 | 工具可用 | 过程卡「工具」计数不再恒 0；需要工具的请求能调用 |
| 4 | 指令加载 | 会话日志出现 `agent-instructions`（对照 a2a 会话） |
| 5 | 老会话 | 对升级前建的会话发消息（legacy 无 preset 头）：resume 后 mount 一次，工具/人格生效且不重复 mount |
| 6 | 已有 preset 会话 | 重启后继续 a2a/其他已带 preset 的会话：不再重复 mount（观察无重复指令/工具） |
| 7 | 失败降级 | 人为让 preset 不存在：日志 warn，会话仍可用，卡片状态行出现「（preset 未挂载）」 |
| 8 | 配置 | `agentPreset: other`：启动日志 `agent preset=other`，新会话头与 composition 都用 other |

## 5. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- `composedPreset` 判定发生在 setup 的 agentCtx 上；额外用 session header lookup 保证
  「已有 preset 的真实 resume」根本不会进入 mount 分支。
- mount 失败不重试；下一次 create/resume 会重新尝试（新会话/新上下文）。
- 若 preset id 配置不存在，dsh mount 抛错 → 走降级，不影响会话；启动日志仍显示配置值。
