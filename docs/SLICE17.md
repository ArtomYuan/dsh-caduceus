# 第十七刀：彻底移除状态卡与 pin（保留 `/status` 命令）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 用户定案与真机证据

用户定案：**不要状态卡**（意义不大），保留 `/status` 命令。

真机证据（2026-11-01 私聊）：
- 01:53:10 创建了一张「飞书会话 · 状态」卡；01:53:49 第二个回合只出了过程卡，状态卡没有更新；
- 日志里也没有任何 pin 行。

结论：状态卡价值不足且实现/运维成本高（跨回合更新失效、pin 受群策略限制），整体移除，
只保留每回合一张过程卡（现行交付形状）与 `/status` 文本命令。

## 1. 删除内容

### 1.1 代码

- `src/pin-store.ts` 整文件删除（`pins.json` 持久记录不再需要）。
- `src/home.ts`：删除 `defaultPinPath`。
- `src/index.ts`：删除 `PinStore` 创建/注入。
- `src/config.ts`：删除 `statusCard`、`pinStatusCard` 配置项/schema/默认值；
  `DEFAULT_STATUS_CARD`、`DEFAULT_PIN_STATUS_CARD` 删除。
- `src/bridge/types.ts`：删除对应 BridgeConfig / BridgeOptions 字段（含 `pinStore`）。
- `src/bridge/bridge.ts`：
  - 删除 `ScopeState.statusStream`、`patchBudget`、`statusDegraded`、`pinnedMessageId`、`pinAttemptedFor`；
  - 删除 `#renderStatus`、`#maybePinStatusCard`、`#pinDisabledChats`、`#pinStore`；
  - 删除所有 `#renderStatus` 调用点（入站、turn/start、step/tool、title、turn/end、`/new`、agent-ready）；
  - `#makeCardStream` 恢复为单过程卡、普通 `card stream failed` 日志。
- `src/render/cards.ts`：删除 `StatusCardInput` / `statusCard()` 构造器。
- `src/render/index.ts`：删除 `statusCard` / `StatusCardInput` 导出。
- `src/render/stream.ts`：删除仅用于双卡共享的 `CardPatchBudget` 与 `budget` 选项/逻辑，
  恢复单卡节流语义。
- `src/status.ts`：删除 `statusCardLines()`（状态卡专用；`/status` 仍用 `statusText()`）。
- `src/transport/feishu-api.ts`、`src/transport/types.ts`、`src/transport/lark.ts`、
  `src/transport/reliable.ts`：删除 `pinMessage` / `unpinMessage` 及其 Lark `im.v1.pin.*` 封装。
- `scripts/smoke.mjs`：删除 pin 假实现与状态卡/pin 断言；断言每回合恰好一张过程卡。
- 启动日志：本刀未新增状态卡/pin 行，既有 ready/backfill 等行保留不变。

### 1.2 测试（允许删除的状态卡/pin 用例）

共删除 11 个用例（194 → 183）：
- bridge：状态卡 4 个（跨回合复用、正文隔离、`statusCard=false`、创建失败降级）；
- bridge：pin 4 个（仅 pin 一次、重启 unpin 旧再 pin 新、230046 禁用、`pinStatusCard=false`）；
- config：`statusCard` 默认值、`pinStatusCard` 默认值 2 个；
- transport：`ReliableTransport` pin/unpin 透传 1 个。

**其他模块用例一个未删**；仅因交付形状变化，对既有过程卡用例做了语义适配
（回合收尾只断言一张过程卡、正文唯一性去除状态卡断言等），覆盖意图不变。

## 2. 保留内容

- 过程卡：每回合一张，运行中带正文尾部，`turn/end` 定格在同一张卡；一个回合只有一张卡，
  无第二条正文文本（编辑失败降级文本逻辑保留）。
- `/status` 命令文本输出内容不变（仍由 `statusText()` 生成）。
- 文件日志、门禁、命令分发、会话键/历史/adopt、ownership/backfill 均未改动。

## 3. 验收

- 两份 tsconfig `--noEmit` 均 0；
- `npm test` 183 全绿；
- `npm run smoke` 通过；
- `grep -ri statuscard src` 为空；`grep -ri pinMessage src` 为空。

## 4. 以后若要恢复，从哪条提交捡回来

按层级回滚（当前删除提交为第十七刀，下面给出功能引入提交）：

1. **状态卡本体**：从 `adf4f45`（restore persistent per-scope status card）取回
   - `src/bridge/bridge.ts` 的 `statusStream`/`#renderStatus`/调用点；
   - `src/render/cards.ts#statusCard`、`src/status.ts#statusCardLines`；
   - `BridgeConfig.statusCard`、`config.ts#DEFAULT_STATUS_CARD` 及 README/测试。
2. **状态卡置顶（pin）**：在状态卡恢复之后，从 `c7e7ce1`（best-effort pin）取回
   - `src/pin-store.ts`、`pins.json` 路径、`#maybePinStatusCard` 与降级；
   - transport 的 `pinMessage`/`unpinMessage`（`feishu-api.ts`/`types.ts`/`lark.ts`/`reliable.ts`）；
   - `pinStatusCard` 配置与相关测试。
3. **卡片演进参考**：`5f353b8`（单张合并卡）、`9ceaf6d`（答案在卡内、收尾编辑同卡）记录了
   交付形状的演化；恢复时注意与后续会话归属/历史功能不冲突。

更稳妥的方式：`git revert <本刀提交>` 后按需保留，或直接 `git checkout adf4f45 -- <文件>` /
`git checkout c7e7ce1 -- <文件>` 拾取对应文件，再跑全量测试与真机验收。

## 5. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- 清理了 `pins.json` 相关代码，但运行环境里可能残留旧 `pins.json` 文件（无代码读取，可手工删除）。
- `statusCard`/`pinStatusCard` 配置项已删除；若旧 profile 仍传这些字段，schemastery 不会报错
  （未知字段通常被忽略），但建议宿主侧同步清理 profile。
- `/status` 文本命令与卡片无关，行为不变。
