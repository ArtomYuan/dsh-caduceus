# 第五十一刀：语言判定修复 + dsh 官方档位文案

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机问题

0.9.0 在真机输出英文：dsh 进程 `LANG=C.UTF-8`，host settings 无
`locale.preference`，旧回退把非 zh 前缀一律判成 en。用户预期默认中文。

## 1. 语言配置与解析

- 新增插件配置 `lang: 'zh' | 'en' | 'auto'`，**默认 `zh`**；
  schema 与 `cordis.patch.yml` 的 gateway row 默认值都写入 `lang: zh`。
- `resolveLang(lang, settingsProvider?)` 优先级：
  1. `lang === 'zh' | 'en'` → 直接用，**不看 settings/env**；
  2. `lang === 'auto'` → settings locale.preference（兼容
     `settings.get('locale').get()` 与 `describe()`）；
  3. 仍 auto → `LC_ALL/LANG`，**只接受以 zh/en 开头**；`C`/`C.UTF-8`/`POSIX`/空忽略；
  4. 最后回退 **zh**。
- settings 读取失败不抛错、不缓存失败。
- 兼容旧调用：`resolveLang(provider)` 视为 `auto + provider`。

## 2. 官方档位文案（单源）

`packages/client/ui-permission-presets/src/client/locales.ts`：

- zh：仅可查看 / 工作区内修改 / 完全权限 / 自动审查（EXP）
- en：Read Only / Workspace Write / Full access / Auto review (EXP)
- 未知档位显示原名。

卡片：
- 标题：`权限 · 当前 <官方标签>`；en `Permissions · current <label>`；
- custom 标题：`权限 · 当前 自定义（不匹配任何预设）`；
- 档位行：`- 官方标签：沙箱 <原值> · 审批 <原值>`；
- 按钮 value 仍为 `{action:'caduceus.permission.switch', name:<原名>}`，按钮标签用官方词。
- `sandbox`/`approval` 原值不翻译；审批摘要仍用 `ask→人工确认 / never→从不`。
- 切换结果：`已切换到 工作区内修改（workspace-write）`。

## 3. 版本

0.9.1；README 增加 `lang` 配置行。

## 4. 测试

原有 335 例保留，新增 10 例，共 **345** 全绿：

- `lang=zh` + `LANG=C.UTF-8` + settings=en → 中文（本次 bug 回归）；
- `lang=en` + 中文环境 → 英文；
- `lang=auto` + `C.UTF-8` → zh；+ `en_US` → en；
- `lang=auto` + settings preference=zh + `LANG=en_US` → zh；
- 官方标签 zh/en 各四档；
- 未知档位回退原名；
- custom 卡片标题；
- 配置 `lang` 默认/覆盖。

## 5. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 默认中文 | 不配 lang、`LANG=C.UTF-8` 下权限卡片为中文 |
| 2 | 显式 lang | `lang: en` 时英文，`lang: zh` 时中文（不受 settings 影响） |
| 3 | auto | 配 `auto` 且无 preference 时仍中文 |
| 4 | 官方文案 | 四档标签为 dsh 官方词，auto 带 EXP |
| 5 | sandbox/approval | 次要行仍显示原值 |
| 6 | custom | 标题显示「自定义（不匹配任何预设）」 |

## 6. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.9.1。
- 仅权限面跟随 lang；其它命令/卡片保持现有文案。
- `lang: auto` 的 C/POSIX 环境明确回退中文，不再误判英文。
- `docs/DESIGN.md` 未触碰；profile 未改。
