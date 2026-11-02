# 第五十刀：权限面板卡片 + 权限面文案跟随 dsh 语言

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 1. i18n

- 新建 `src/i18n.ts`：`Lang = 'zh'|'en'`、`resolveLang(settingsProvider?)`、`t(lang)` 字典。
- 语言来源：
  1. `ctx.get('settings')` 的 locale 段（兼容 `settings.get('locale').get()` 与
     `settings.describe()` 两种形态）；
  2. `LC_ALL` / `LANG`（`zh*` → zh，其他非空 → en）；
  3. 都没有 → zh。
- 读取失败/服务缺失只回退，不抛错、不缓存失败（每次重新尝试）。
- 字典不含拼接式用户句子；带参数句子用字典函数（普通字符串连接）。

## 2. 权限卡片

- 新建 `src/render/permission-card.ts`：
  - `buildPermissionCard({lang,current,presets})`
  - `renderPermissionText(...)`
  - 两者共用同一份 `lines()` 数据；卡片额外带按钮。
- 预设数据仍来自 `permissionPresets.resolve(name)`；`sandbox`/`approval` 原样保留。
- 按钮 `value: {action:'caduceus.permission.switch', name}`。
- `/permission` 无参：先发卡片；发送失败 → 同一渲染器的文本降级。
- 按钮回调：`InteractiveRuntime` 新增 `permissionSwitch` 路由 →
  `Bridge.handlePermissionCardAction` → 按 messageId 找 state/owner → 复用 dsh 的
  `/permission <name>` 执行切换 → patch 同一张卡片 → 回复切换结果。
- 私聊/话题：卡片仍走 `#sendNewCard(state, card)`，话题内 reply + threadId。

## 3. 审批卡与 /status

- 审批卡片顶部加一行当前档位/审批：
  `档位 workspace-write · 审批 人工确认`（en 对应 `preset … · approval manual confirmation`）。
  审批值 `ask`→人工确认 / `never`→从不；无值显示 `?`。
- `/status` 末尾增加同一行权限摘要。
- 本阶段只动权限面；`/whoami` 等其它命令保持原中文。

## 4. 版本

0.9.0；README `/permission` 行注明权限卡片与语言跟随。

## 5. 测试

原有 321 例保留，新增 14 例，共 **335** 全绿：

- i18n：默认 zh、LANG=zh_CN/en_US、settings preference 优先、settings 缺失/抛错回退、
  字典字段；
- 渲染：zh/en 卡片快照、卡片/文本同数据、按钮 payload；
- bridge：发送失败文本降级、按钮回调执行切换并 patch、审批卡档位行、/status 权限行。

## 6. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 权限卡片 | `/permission` 出卡片：当前档位 + 各档沙箱/审批 + 按钮 |
| 2 | 按钮 | 点档位按钮后实际切换，卡片更新，回复切换结果 |
| 3 | 语言 | dsh 为 en 时权限面英文；zh 时中文 |
| 4 | 审批卡 | 审批卡顶部有「档位 … · 审批 …」 |
| 5 | /status | 状态回复含权限摘要行 |
| 6 | 失败降级 | 卡片发不出去时收到等价文本 |

## 7. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.9.0。
- 仅权限面多语言；其它命令/卡片保持现有中文。
- locale 读取兼容 settings 的两种形态；失败不缓存。
- `docs/DESIGN.md` 未触碰；profile 未改。
