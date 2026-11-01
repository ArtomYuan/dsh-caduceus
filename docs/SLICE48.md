# 第四十八刀：接管 `/permission` 并输出中文

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 背景

dsh 的 `/permission` 只输出英文：
`current preset X (available: …)` / `unknown preset "X"` / `preset X`。
服务 `ctx.permissionPresets` 暴露 `names` / `current(session)`；`apply` 私有，不能重实现。
本刀只换呈现，切换仍走 dsh 命令。

## 1. 实现

### 1.1 自有命令

- `COMMAND_NAMES`/SPECS 增加 `permission`（`/permission [档位]`）；
- 从 `DSH_NATIVE_COMMANDS` 移除 `/permission`，`/help` 归入自有命令段；
- 其他透传命令（`/compact` `/goal` `/plan` `/feedback`）保持英文。

### 1.2 无参（服务可用）

```
当前档位：workspace-write
可用档位：
- read-only：只读，不能写文件
- workspace-write：可写会话工作区，越界需审批
- danger-full-access：沙箱全开，审批 never（慎用）
用法：/permission <档位>
```

固定中文映射；未知档位显示原名。当前档位来自
`permissionPresets.current(agent.session)`，列表来自 `names`。

### 1.3 带参（服务可用）

- 先按 `names` 校验；未知 → `未知档位 X，可用：…`，**不调用**底层命令；
- 合法 → `runHarnessCommand(agent, '/permission <name>')` 执行切换，然后翻译：
  - `preset X` → `已切换到 X（<中文描述>）`；
  - `unknown preset "X" (available: …)` → `未知档位 X，可用：…`；
  - 其他文本 → `已执行 /permission X（dsh 原文：…）`。

### 1.4 服务缺失

`permissionPresetsProvider()` 返回 undefined 时，无参与带参都原样转发 dsh，
并加前缀 `（dsh 原文）`，不自行翻译、不校验。

### 1.5 接线

- `BridgeOptions.permissionPresetsProvider`，index 惰性取
  `ctx.get('permissionPresets')`；
- 版本 0.8.1；README 命令表/数量（14）已同步。

## 2. 测试

原有 313 例保留，新增 5 例，共 **318** 全绿：

- 无参中文三行 + 档位列表 + 当前档位；
- 切换 → 底层命令调用一次，返回中文；
- 未知档位 → 中文提示，底层零调用；
- 服务缺失（无参/带参）→ 英文透传 + `（dsh 原文）`；
- `/help` 分段：`/permission` 在自有段，原生命令段不含它。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 无参 | `/permission` 显示中文当前档位与档位列表 |
| 2 | 切换 | `/permission workspace-write` 返回「已切换到 …」且实际生效 |
| 3 | 未知 | `/permission nope` 显示「未知档位 nope，可用：…」 |
| 4 | 服务缺失 | 显示 `（dsh 原文）` 与英文输出 |
| 5 | /help | `/permission` 在自有命令段 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.8.1。
- 切换动作完全复用 dsh 的 `/permission` 命令；未重实现 apply。
- 中文映射只覆盖内置三档；未知档位显示原名。
- `docs/DESIGN.md` 未触碰；profile 未改。
