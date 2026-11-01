# 第四十三刀（P0）：turn/end 终态以事件为准，不再用陈旧快照

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机证据

- 会话 turn 8：`turn/start 22:48:05` → `turn/end completed 22:48:14`；
- 卡片正文已写入回复，但状态行仍显示
  `运行中 · 步数 1 · 工具 0 · 已运行 9s`。

说明 settle 的 patch 发了（正文在里面），但用了陈旧的 `state.status.get()` 快照。

## 1. 改动

### 1.1 事件优先

`#settleTurn` 一开始就取事件判定终态：

```ts
const kind = turnEndReasonKind(event.data);
const finalState = stateForTurnEnd(kind);
const finalStateLabel = statusLabel(finalState);
state.status.apply(event); // 再补一次终态，保证 /status 一致
const snapshot = state.status.get();
```

映射（`stateForTurnEnd`）：

- `completed` / `undefined` / `forked` → `完成`
- `error` / `max-tokens` → `失败`
- `interrupted` / `aborted` → `已中断`
- `blocked` → `待审批`

### 1.2 finalCardInput 签名

```ts
#finalCardInput(
  state: ScopeState,
  snapshot: StatusSnapshot,
  body: string,
  finalState: StatusState,
  finalStateLabel: string,
): FinalCardInput
```

- `stateLabel` 只用 `finalStateLabel`（事件派生），**不再读 snapshot.state**；
- `template` 用 `statusTemplate(finalState)`（终态颜色也以事件为准）；
- snapshot 只提供 steps/tools/startedAt/endedAt/recentEvent 等数值。

### 1.3 空正文

`body = 本轮已结束（${finalStateLabel}）。`，因此空正文也显示终态与占位。

### 1.4 版本

0.5.1。

## 2. 测试

原有 288 例保留，新增 3 例，共 **291** 全绿：

- turn/end completed → 卡片状态行 `完成`，不残留 `运行中`；
- error → `失败`；interrupted → `已中断`；
- 空正文 → 终态 + `本轮已结束（完成）`。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 完成 | 正常回合结束，卡片状态行 `完成`，不是 `运行中` |
| 2 | 失败/中断 | error/interrupted 结束，卡片 `失败`/`已中断` |
| 3 | 空答复 | 只发图片或空回复后，卡片仍显示终态 + “本轮已结束” |
| 4 | /status | 同一时刻 `/status` 与卡片终态一致 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.5.1。
- 终态判定仍沿用现有 `stateForTurnEnd` 映射；未改任何事件解释逻辑。
- `docs/DESIGN.md` 未触碰；profile 未改。
