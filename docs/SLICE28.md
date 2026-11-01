# 第二十八刀：`/doctor` 三处打磨（提示独立计数 / pending 文案 / 上一回合）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 真机现状

```
○ 工具 · pending（尚未收到首条 request/header）
! 遗留块 · ~/.agents/AGENTS.md（可删除）
【结论】10 项正常 · 0 项异常 · 4 项跳过
```

问题：
1. `!` 被算进“正常”，看不出是提示；
2. pending 文案让人误以为坏了，其实只是 `/doctor` 命令回合没经过 agent；
3. 命令回合看不到上一次真实回合的信息；
4. 手动清掉旧遗留文件后不该再报 `!`。

## 1. 改动

### 1.1 结论四段计数（`!` 独立）

- `counts.normal` 只统计 ✓；`warn` 单独统计 `!`，不计入异常。
- 结论行：
  `N 项正常 · M 项异常 · P 项提示 · K 项跳过`；P=0 时**省略**“项提示”段。
- JSON `counts` 同步含 `normal/fail/warn/skip`。

### 1.2 命令回合 pending 文案

- preset / 工具 / 当前会话工具数在无数据时统一显示：
  `pending（命令回合未经 agent；发一句话后可知）`
- 不再使用“尚未收到/尚未发起”这种像故障的措辞。

### 1.3 「上一回合」栏

- Bridge 在会话请求头到达时缓存最近一次 agent 回合：
  `{ preset?, toolsCount, at }`（`ScopeState.lastAgentTurn`）。
- `/doctor` 的 session 信息带上该缓存：
  - 有缓存 → 运行时栏多一行 `✓ 上一回合 · preset=standard，工具 37，2m 前`（`ok`，不计入跳过）；
  - 无缓存（从未有 agent 回合）→ 该行不出现。
- 这样命令回合也能看到上一次真实回合的 preset/工具数/相对时间。

### 1.4 遗留块降级

- `<DSH_AGENTS_HOME>/AGENTS.md` 不存在（或没有标记）→ 不生成 `!` 项，也不计入提示；
- 手动清理后再跑 `/doctor` 应为 0 项提示。
- 仅当旧文件仍含本插件标记时才显示 `! 遗留块 · …（可删除）`。

### 1.5 `--json`

- 新增 `warnings: DoctorItem[]` 与 `lastTurn: { preset?, toolsCount?, at, relative } | null`；
- 全部字段与文本一致，仍不含 appSecret。

## 2. 实现要点

结论四段（节选）：

```ts
const counts = {
  normal: items.filter((entry) => entry.mark === 'ok').length,
  fail: items.filter((entry) => entry.mark === 'fail').length,
  skip: items.filter((entry) => entry.mark === 'skip').length,
  warn: items.filter((entry) => entry.mark === 'warn').length,
};
const conclusion = [
  `${counts.normal} 项正常`,
  `${counts.fail} 项异常`,
  ...(counts.warn > 0 ? [`${counts.warn} 项提示`] : []),
  `${counts.skip} 项跳过`,
].join(' · ');
```

上一回合栏（节选）：

```ts
const lastTurnInput = inputs.session.lastTurn;
const lastTurnItem =
  lastTurnInput === undefined
    ? undefined
    : await safeItem('runtime', 'last-turn', '上一回合', () => ({
        mark: 'ok',
        detail: `preset=${lastTurnInput.preset ?? '?'}，工具 ${lastTurnInput.toolsCount ?? '?'}，${relativeAge(lastTurnInput.at, now)}`,
      }));
```

Bridge 缓存（节选）：

```ts
state.lastAgentTurn = {
  ...(this.#selfCheck?.presetId() === undefined ? {} : { preset: this.#selfCheck?.presetId() }),
  toolsCount: toolCount,
  at: event.time ?? this.#now(),
};
```

## 3. 测试

- 原有 233 例全部保留，新增 3 例，共 **236 例全绿**：
  - `结论四段计数：有 ! 项时独立统计「P 项提示」，无提示则省略`
    （同时验证旧遗留文件删除后零提示、文本不再出现遗留块）；
  - `命令回合：preset/工具/当前会话工具数 显示 pending 原因，不显示上一回合`；
  - `有缓存回合：显示「上一回合」行，且不计入跳过；JSON 带 lastTurn`
    （含 warnings/lastTurn 字段校验）；
  - Bridge `/doctor` 用例增强：先产生 request/header，再断言「上一回合」行与工具数。
- 全部注入式（mkdtemp、假 doctorInputs/transport），不碰真实 `~/.dsh`。

## 4. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 提示计数 | 旧 `~/.agents/AGENTS.md` 有块时：结论含 `· 1 项提示 ·`，异常仍为 0 |
| 2 | 清理后 | 删除旧文件再 `/doctor`：不再出现 `! 遗留块`，结论无“项提示”段 |
| 3 | 命令回合 | 刚启动直接 `/doctor`：preset/工具/当前工具数均为 pending（命令回合未经 agent），不是故障措辞 |
| 4 | 上一回合 | 先发一句话再 `/doctor`：运行时栏出现 `✓ 上一回合 · preset=…，工具 N，…前`，且跳过计数不含它 |
| 5 | JSON | `/doctor --json` 含 `counts.warn`、`warnings`、`lastTurn`（无缓存为 null） |
| 6 | 无回归 | 结论计数、其他检查项、doctor 日志行仍正确 |

## 5. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 上一回合缓存是进程内状态，重启后首次 `/doctor`（未说话前）仍显示 pending。
- 缓存只记最近一次真正到达 request/header 的回合；失败在请求前中断的回合不会产生缓存。
- `!` 只用于“可操作提示”（当前仅遗留块），不计异常、不计跳过。
