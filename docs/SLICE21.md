# 第二十一刀（P0 续）：`agentPresets` 惰性解析

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 根因

真机日志：`WARN [caduceus] agentPresets service unavailable; preset standard not mounted ...`，
会话头仍无 `agentPreset`、`agent-instructions` 仍为 0。

`src/index.ts` 在 `apply` 时一次性执行 `ctx.get('agentPresets')` 并存成常量；此时
`agent-preset-registry` 尚未挂载 → 永远 `undefined`。与之前 `sessionTitle` 的 bug 同型。

## 1. 改动

### 1.1 惰性解析（不缓存 undefined）

- `BridgeOptions` 新增 `agentPresetsProvider?: () => AgentPresetsLike | undefined`；
  `agentPresets`（直接值）保留给测试，provider 优先。
- `src/index.ts` 改为传函数：

  ```ts
  // Lazy per use: the preset registry can register AFTER this plugin mounts.
  agentPresetsProvider: () => ctx.get('agentPresets') as AgentPresetsLike | undefined,
  ```

- `Bridge#resolveAgentPresets()`：
  - 命中已缓存的成功服务 → 直接复用；
  - 否则每次调用 provider；成功才写缓存；
  - **失败/undefined 不写缓存**，下一次 create/resume 会再次解析。
- 首次成功解析时打一行 info：
  `agentPresets resolved; mounting <preset>`；仍拿不到则保留原 warn
  `agentPresets service unavailable; preset <id> not mounted for <session>`。

### 1.2 关于 `inject`

要求中的声明式依赖已实测：当前 cordis（0.4.x）的 `Inject` 类型是
`(service names)[] | { [service]: interceptConfig }`，**没有 optional 形态**；
把 `agentPresets` 加进 `inject` 会让插件变成“等待该服务可用才加载”，在 preset 插件缺失或
加载顺序靠后时会阻塞整个 gateway —— 与“加载不被卡住、服务就绪后能拿到”的目标相反。
因此本刀不声明静态 `inject`，采用惰性 `ctx.get` + 成功缓存：
插件立即加载；服务就绪后的第一次 create/resume 自动解析到并 mount。

### 1.3 create / resume 行为不变

- create：`meta.agentPreset` + setup mount（惰性服务）；
- legacy resume（头无 preset）：setup 里 mount 一次；
- 会话头已有 preset：不传 setup，零 mount；
- `#mountPreset` 内部 `composedPreset` 命中仍跳过（避免重复组合）。

## 2. 测试

- 原有 205 例全部保留，新增 2 例，共 **207 例全绿**：
  - `agentPresets 惰性解析：apply 时缺失不缓存，服务晚注册后 create 能拿到并 mount`
    （第一次 lookup 无服务 → warn；服务出现后第二次 create lookup 成功、mount 一次、
    日志出现 `agentPresets resolved; mounting standard`）；
  - `agentPresets 解析成功后复用缓存：第二次 create 不再重新解析`
    （provider 只调用 1 次；两个 agent 各 mount 一次；resolved 日志只 1 行）。
- 现有 create/resume/mount 失败/legacy/header-preset 用例全部保持通过。
- 全部注入式（假 provider/presets/agents），不碰真飞书与真实 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 不再出现永久降级 | 重启后首次 create/resume：日志出现 `agentPresets resolved; mounting standard`，不再出现 service unavailable |
| 2 | 会话头 | 新建会话头含 `"agentPreset":"standard"` |
| 3 | 人格/指令 | 新对话人格生效；会话日志出现 `agent-instructions` |
| 4 | 工具 | 过程卡工具计数不再恒 0，需要工具的请求可调用 |
| 5 | 顺序无关 | 即使 preset registry 晚于 gateway 注册，第一条消息创建会话时仍能解析并 mount（无需重启插件） |
| 6 | 老会话 | legacy 会话 resume 后补挂一次；有 preset 头的不重复 mount |
| 7 | 失败可重试 | 人为让首次解析失败：本次 warn，下一次 create/resume 会重试并成功 |
| 8 | 加载不阻塞 | gateway 正常 ready（不因 agentPresets 缺失而卡住） |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 缓存只存成功解析的服务；服务若在运行中被替换（极少见）不会主动失效，需要重启进程。
- 首次解析失败仍会给当前会话打 `（preset 未挂载）`，但不会缓存失败状态。
- cordis 无 optional inject 是当前版本能力限制；后续若支持可选 inject，可再改为声明式。
