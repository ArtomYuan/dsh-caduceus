# 第五十二刀：权限卡片精简为「当前 + 用法 + 按钮」

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 1. 卡片

zh：

```
权限 · 当前：工作区内修改
用法：/permission <档位>，或点下方按钮
[仅可查看] [工作区内修改] [完全权限] [自动审查（EXP）]
```

en：

```
Permission · current: Workspace Write
Usage: /permission <preset>, or tap a button below
[Read Only] [Workspace Write] [Full access] [Auto review (EXP)]
```

- 只保留标题（当前档位）、一行用法、一行按钮；
- 删除了每档后的 `沙箱 X · 审批 Y`（卡片与文本降级都删）；
- 当前档位按钮 `disabled: true`（置灰），其他按钮可点；
- 按钮 value 仍是 `{action:'caduceus.permission.switch', name:<原名>}`；
- 具体预设显示官方标签，`custom` 显示
  `自定义（不匹配任何预设）` / `Custom (matches no preset)`。

## 2. 文本降级

卡片发送失败时输出同样的三项：

```
权限 · 当前：工作区内修改
用法：/permission <档位>，或点下方按钮
仅可查看 / 工作区内修改 / 完全权限 / 自动审查（EXP）
```

不含 sandbox/approval 技术值。

## 3. 切档刷新

按钮回调仍走 `handlePermissionCardAction` → 复用 dsh `/permission <name>` →
重新渲染同一张卡（新当前档位标签、对应按钮置灰）。

## 4. 版本

0.9.2。

## 5. 测试

原有 345 例保留，新增/更新后共 **347** 全绿：

- zh/en 卡片：标题、唯一用法行、四按钮；
- 卡片 JSON 不含 `沙箱`/`审批`/`sandbox`/`approval`；
- custom 与具体预设两种标题；
- 文本降级同样三项且无技术值；
- 当前按钮 disabled、value 带原名；
- 未知档位回退原名；
- 切档后原地刷新卡为新标签。

## 6. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 精简卡片 | `/permission` 只有当前、用法、按钮三行 |
| 2 | 无技术值 | 卡片里看不到沙箱/审批 |
| 3 | 当前按钮 | 当前档位按钮置灰，点其他按钮可切 |
| 4 | 原地刷新 | 切档后同一张卡标题变为新档位 |
| 5 | custom | 标题显示「自定义（不匹配任何预设）」 |
| 6 | 降级 | 卡片失败时文本同样是三项，无技术值 |

## 7. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.9.2。
- 审批卡/`/status` 的权限摘要行不受本刀影响（仍显示档位与审批语义）。
- `docs/DESIGN.md` 未触碰；profile 未改。
