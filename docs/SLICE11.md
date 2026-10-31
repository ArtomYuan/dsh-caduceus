# 第十一刀：旧会话真正可达（session-map v5 + history）

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰生产 `~/.dsh` 数据。

## 0. 真机证据（2026-11-01 00:31，伊冯私聊）

- `/sessions --all` 之前能列出 `63503786`（`feishu-1793463503786`，磁盘上存在）；
- `/resume 63503786` → 「没找到匹配的会话」；
- 磁盘上 `feishu-1793463503786` 仍存在，但 session-map 里该 chat 只剩当前 id `feishu-1793464086695`。

**根因**：session-map 每个 key 只存当前 sessionId；`/sessions --all` / `/resume` 的搜索范围是「当前 + 内存里的 previousSessionId」。进程重启或多次切换后，旧 id 完全不在搜索范围 —— 上一刀的「旧会话可达」只在同一进程内成立。

## 1. 改动

### 1.1 session-map 升 version 5：每个 key 带 history

- 新结构：
  ```json
  {
    "version": 5,
    "entries": {
      "oc_x\u0000ou_user": {
        "sessionId": "feishu-1793464086695",
        "history": ["feishu-1793464086695", "feishu-1793463503786"]
      }
    },
    "cwd": {}
  }
  ```
- `history`：最近 50 个会话 id，去重、新在前，`history[0]` 通常就是当前 id（当前 + 历史一起保留）。
- `SessionStore.set()` 负责迁移：新 id 提到 history 首位，旧 current 保留在后面；`/new`、`/resume` 切换、remint 全部走 `set()`，因此**每次变更后立即原子写盘**（沿用 temp+rename）。
- 兼容读：v5 正常读；**v4/v3 迁移为当前 id + `history=[]`**（不丢当前、不批量改写旧键）；v2/v1 同样迁移。`load()` 永不写盘，下一次 persist 写 v5。

### 1.2 `/sessions --all` 枚举当前 + history

- 对同一 chatId 的所有 scope：先列当前 scope 的当前 id、再列其 history；然后按 key 排序列出其他 scope 的当前 + history；按 sessionId 去重。
- 当前会话行 `* `；每行仍带 `时间 · 后 8 位 · scope 标签`；live 会话或磁盘有日志才算已落地，否则 `（未落地）`。
- 末尾提示 `用 /resume <id 后 8 位> 继续某条会话`。

### 1.3 `/resume` 搜索当前 + 全量 history

- 候选来源：本 chat 所有 scope 的当前 id + `history()`（去重）。
- 匹配规则不变：完整 id 优先，否则 ≥8 位不歧义尾号；歧义列候选（≤5），零命中「没找到」。
- 命中后 `#switchSession` 调 `SessionStore.set()`：该 id 成为当前 scopeKey 的当前会话，并置于 history 首位（旧 current 保留在 history 中，仍可再次恢复）。
- 重启后无需内存 previousSessionId，history 来自磁盘。

## 2. 测试

- 原有 165 例全部保留（v5 结构相关的旧断言更新为 `{sessionId, history:[]}` / `history:[id]`，意图不变），新增 7 例，共 **172 例全绿**：
  - `SessionStore: v4→v5 迁移 —— 老单 id 保留为当前，history=[]，load 不改写`；
  - `SessionStore: set 迁移 —— 新 id 提到 history 首位，去重且最多 50 条`；
  - `SessionStore: 重新 load 后 history 与当前 id 都保留（重启模拟）`；
  - `history：/new 把旧 id 留在 history，/sessions --all 枚举当前 + 历史`；
  - `重启模拟（v5 从磁盘 load）：/resume 命中 history 中的旧 id，并提到 history 首位`；
  - `/sessions --all：历史条目也带幽灵标记`；
  - `/resume 歧义：历史中两条同尾号给出候选且不切换`。
- 全部注入式（假 transport/agents/clock、mkdtemp），不碰真飞书与真 `~/.dsh`。

## 3. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | session-map 变 v5 | 重启后查看 `$DSH_HOME/caduceus/session-map.json`：`version: 5`，每个 key 有 `history`，当前 id 在首位 |
| 2 | 旧 id 可达 | `/sessions --all` 应能看到 `feishu-1793463503786`（尾号 63503786）；`/resume 63503786` 成功切回，不新建 |
| 3 | 重启后仍可达 | 再次重启，重复步骤 2；history 来自磁盘，不依赖内存 previous |
| 4 | history 增长 | 连续 `/new` / `/resume` 后检查 history：新 id 在前、去重、≤50 |
| 5 | 幽灵标记 | 磁盘无文件的历史 id 在 `--all` 行末显示 `（未落地）`；真实存在的历史 id 不显示 |
| 6 | 歧义/零命中 | 构造同尾号历史 → 候选 ≤5 不切换；随机尾号 → 「没找到」 |
| 7 | 旧数据兼容 | 升级前 v4 文件被读入后不丢当前 id；下一次写盘才转 v5 |
| 8 | 原有命令回归 | `/new` 物化、`/rename`、标题、`/status`、门禁、日志均不回归 |

## 4. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- history 上限固定 50（不提供配置）；更早的 id 从列表消失，但磁盘会话文件仍在，需手动按完整 id 恢复。
- 只保留每个 scope key 的 50 条；跨 scope 的历史仍按各 key 独立维护。
