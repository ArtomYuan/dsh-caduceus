# 第六十刀：修客户端注册（只碰 list 槽）+ 工作台包协议/自检（0.12.0）

状态：**构建 + 静态自检通过；真机 web 加载待安装/重启验证。**
未改 dsh/profile、未安装、未重启。

## 1. 客户端注册修复

`main` / `main.*` / `shell.overlay` 是宿主已占用的 single 槽；再注册会抛
“Declaring is claiming”（`ui-slots/src/index.ts:152`），导致 entry failed。
本版不再碰这些槽，只用两个 list 槽：

| 槽 | 作用 | 依据 |
|:--|:--|:--|
| `conversation.session.header.actions` | header「双蛇杖」按钮，点开自渲染抽屉 | `ui-conversation/src/client/contract/slots.ts:133` |
| `settings.general.item` | General 设置页只读行：lang/metrics/busyMode | `ui-settings/src/client/contract/slots.ts:89` |

- 未使用 `ctx.slots.inject`（本版 ui-slots 不提供）。
- 抽屉由 client 自己创建 fixed DOM，不注册 main 面板，也不用 shell.overlay。
- 会话 id 从 header 槽的 session 作用域标准 prop `sessionId` 取
  （`ui-session/src/client/index.ts:112-117`）。
- 设置值由 host 在 `webserver/index-inject` 注入全局
  `__CADUCEUS_CLIENT_CONFIG__ = {lang, metrics, busyMode}`；client 同步读，只读展示。
- 文案仍走 `locale.register(NS, {zh, en})`。

### header 按钮注册（≤10 行，含原因注释）

```ts
// 不用 main/main.*/shell.overlay：宿主 single 槽已被占用
// （ui-slots/src/index.ts:152 "Declaring is claiming"）。
ctx.slots.register(
  { name: 'conversation.session.header.actions', id: 'caduceus', order: 40, locale: NS },
  HeaderAction,
);
```

### 设置项注册（≤10 行，含原因注释）

```ts
// 同上：只贡献 list 槽；single 槽再注册会 entry failed。
ctx.slots.register(
  { name: 'settings.general.item', id: 'caduceus', order: 40, locale: NS },
  SettingsItem,
);
```

## 2. 工作台包协议

新增 `docs/WORKBENCH.md`：

- 包协议：`dsh.bundle.patch`、`dsh.client.platform=web`、`exports['./client']`、
  `window.__ModuleLoader__.load({id,factory})`；
- 安装/卸载（含 `--config.minimumReleaseAge=0` 坑）；
- 权限与限制（single 槽不可贡献、无 main 面板、20 次编辑上限等）；
- 可勾选验收清单（每项带怎么验 + 证据形式）；
- 状态语义：提交 ≠ 合并 ≠ 发布 ≠ 安装 ≠ 可见。

## 3. 自检

新增 `scripts/check-workbench.mjs` 与 `npm run check`，静态检查：

- `dsh.bundle.patch` / `dsh.client.platform` / `exports['./client']`；
- `lib/client.js` 存在且首行是 `window.__ModuleLoader__.load({`；
- README 与 WORKBENCH 必需章节；
- 版本三处一致：`package.json`、`lib/client.js`、`docs/WORKBENCH.md`。

真实输出（当前）：

```text
$ npm run check
ok - dsh.bundle.patch
ok - dsh.client.platform
ok - exports["./client"]
ok - lib/client.js closure-factory first line
ok - lib/client.js embeds version 0.12.0
ok - README has ## Install
...
check-workbench: 18 passed, 0 failed
```

## 4. 构建产物体积

```text
$ npm run build
ℹ lib/client.js      5.14 kB │ gzip: 2.08 kB
ℹ lib/client.js.map  9.42 kB │ gzip: 3.25 kB

$ ls -l lib/client.js
-rw-rw-r-- 1 artom artom 5145 ... lib/client.js
```

host `dist/` 仍由 `tsc -p tsconfig.json` 产出；client 代码位于 `client/`，
不进入 host tsconfig，独立 `tsconfig.client.json` 仅本地 typecheck。

## 5. artifact 模拟加载

用假 `__ModuleLoader__` + React stub 执行 `lib/client.js`：

```json
{
  "registrations": ["conversation.session.header.actions", "settings.general.item"],
  "drawerTexts": ["Caduceus Workbench", "Version 0.12.0", "Session: feishu-abc123", "Panel loaded", "Close"],
  "rowTexts": ["Caduceus", "Language: zh · Metrics: compact · Busy mode: queue"]
}
```

## 6. 测试与未验证项

- 主包 412 用例全绿；`tsc` 双 0；client 独立 typecheck 0。
- **真机 dsh web 加载未验证**：需宿主安装 0.12.0 并重启；
  页面是否出现 header 按钮/设置行、抽屉与配置值是否真实，以真机验收清单为准。
- 若 profile 没有 host 行，client-modules 不会扫描 client；本版未改 profile。
- 设置值注入依赖 dsh web 的 `webserver/index-inject`；非 web 面不注入，client 显示
  “客户端配置尚未注入”。

## 7. 真机待确认（安装 + 重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | header 按钮 | 会话右上方出现「双蛇杖」 |
| 2 | 自渲染抽屉 | 点击出现版本/当前 sessionId/面板已加载，点关闭消失 |
| 3 | 设置行 | Settings → General 出现「双蛇杖」行，显示 lang/metrics/busyMode |
| 4 | 无 single 注册错误 | 页面 console 无 entry failed / Declaring is claiming |
| 5 | 版本 | 抽屉显示 0.12.0 |
