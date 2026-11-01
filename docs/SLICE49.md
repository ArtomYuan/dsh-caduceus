# 第四十九刀：修 `/permission` 的 custom 与 auto 描述

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机反馈

```
当前档位：custom
...
- auto：auto        ← 没有描述，像是瞎编漏了
```

两个根因：

1. 本插件默认 `approvalPolicy: 'ask'` 会调 `approval.setPolicy(agent,'ask')`；
   `danger-full-access` 预设自带 `approval: never`，组合不匹配任何预设 → 服务返回 `custom`。
2. `auto` 是 dsh 预设表里真实存在的档位，但中文描述表只硬编码了三个；未知档位直接回原名。

## 1. 改动

### 1.1 默认不再覆盖审批策略

- `approvalPolicy` 默认改为 **undefined = 不动 dsh**（config/schema/bridge 类型同步）；
- `#applyApprovalPolicy`：`policy === undefined` 直接 return，不取服务、不 setPolicy、不打会话日志；
- index 启动时只有显式配置才打：`approval policy override=<x>`；否则不打；
- README 配置行改为「未设置 / 默认不动 dsh 的审批策略」。

### 1.2 档位描述从 `permissionPresets.resolve()` 实测

```ts
const spec = service.resolve?.(name);
if (spec !== undefined) {
  const sandbox = spec.sandbox ?? '?';
  const approval = spec.approval ?? '?';
  const hint = PRESET_DESCRIPTIONS[name];
  line = `- ${name}：沙箱 ${sandbox} · 审批 ${approval}${hint ? `（${hint}）` : ''}`;
}
```

- 以 `{sandbox, approval}` 实测值为准；
- 固定中文短语只作为括号补充（内置三档），未知档位（如 `auto`）也至少有
  `沙箱 … · 审批 …`；
- `resolve` 抛错 → 该行只显示 `- <name>`，不崩。

### 1.3 custom 说人话

- 当前档位为 custom：
  `当前档位：custom（当前沙箱/审批组合不匹配任何预设）`
- 额外一行：`用 /permission <档位> 回到某个预设`

### 1.4 版本

0.8.2。

## 2. 测试

原有 318 例保留，新增/更新后共 **321** 全绿：

- 默认不配置 → `setPolicy` 零调用、无 `agent approval policy` 日志；
- 显式 `approvalPolicy: 'ask'` → 调用一次；
- 无参 → 每档含 `沙箱 x · 审批 y`，含 `auto`（审批缺失显示 ?）；
- current=custom → 人话说明 + 指引行；
- `resolve` 抛错 → 只显示 `- name`，不崩；
- 服务缺失（显式覆盖时）仍只 warn 一次；
- resume 路径在显式覆盖时仍调用 setPolicy。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 不再 custom | 不配置 approvalPolicy，重启后 `/permission` 当前档位应与预设一致 |
| 2 | 覆盖才生效 | 显式配置 approvalPolicy 时才出现 `approval policy override=…` 且覆盖 |
| 3 | 实测描述 | 每档显示 `沙箱 … · 审批 …`；auto 也有值 |
| 4 | custom 提示 | 若仍 custom，显示原因与「回到预设」指引 |
| 5 | resolve 异常 | 某档 resolve 抛错时只显示名字，命令不崩 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.8.2。
- profile 未改；原有 profile 里的 `approvalPolicy` 行为由宿主侧决定是否调整。
- 默认「不动」意味着审批策略完全由 dsh 的 preset/配置决定，插件不再暗中改成 ask。
- `docs/DESIGN.md` 未触碰。
