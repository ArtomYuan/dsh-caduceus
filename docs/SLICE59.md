# 第五十九刀：主包真实 client 半（0.11.0）

状态：**构建通过、artifact 加载模拟通过；真机 dsh web 加载待安装 + 重启验证。**
未改 dsh/profile、未安装、未重启。

## 1. 本版范围

- `shell.overlay` 常驻开关：`[ 对话 | 双蛇杖 ]`；
- `main` keyed 面板 `key: 'caduceus'`：标题「双蛇杖工作台」、插件版本、`面板已加载`；
- `npm run build` 同时产出 host（`dist/`）与 client（`lib/client.js`）；
- 版本 0.11.0；新增 `dsh.client` 与 `exports['./client']`。

## 2. 新增/改动文件

- `client/index.ts`：client 半入口，注册 `main` 与 `shell.overlay`；
- `client/labels.ts`：zh/en 文案字典；
- `client/react.d.ts`：最小 React 类型声明（不打包 react）；
- `tsdown.client.mjs`：client 构建配置（closure-factory、`neverBundle:['react']`）；
- `scripts/build-client.mjs`：调用 dsh checkout 自带 tsdown（不安装依赖）；
- `tsconfig.client.json`：client 独立 typecheck（不进入 `npm test`/主 tsconfig）；
- `package.json`：`exports['./client']`、`dsh.client`、`files` 加 `lib/`、build 链、0.11.0。

## 3. 构建

```bash
npm run build
# = tsc -p tsconfig.json && node scripts/build-client.mjs
```

真实产物：

```text
$ ls -l dist/ lib/
-rw-r--r-- 1 artom artom 14093 ... dist/index.js
-rw-r--r-- 1 artom artom  3704 ... lib/client.js
-rw-r--r-- 1 artom artom  7080 ... lib/client.js.map
```

client 体积 **3.70 kB**（gzip 1.61 kB）/ sourcemap 7.08 kB。

## 4. 源码依据

### main 槽 keyed 注册

- `ui-layout/src/client/index.ts:153`：`'main': { kind: 'keyed', scope: 'root' }`；
- `AppFrame.tsx:42`：`renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`；
- 本包注册：`ctx.slots.register({ name: 'main', key: 'caduceus', locale: NS }, WorkbenchPanel)`。

### shell.overlay 渲染点

- `ui-layout/src/client/index.ts:155`：`'shell.overlay': { kind: 'list', scope: 'root' }`；
- `AppFrame.tsx:200`：`renderSlot('shell.overlay', {})`；
- 本包注册：`ctx.slots.register({ name: 'shell.overlay', locale: NS }, ...)`。

### 当前面板与 selectPanel

- `ui-layout/src/client/service.ts:21`：`PanelInfo.activePanelId`；
- `ui-layout/src/client/index.ts:43`：root 标准 prop `usePanelInfo`；
- `ui-layout/src/client/service.ts:68-73`：`selectPanel(null|id)`，未注册的 main key 会抛错；
- 组件优先 `usePanelInfo(info => info.activePanelId)` 读 store；hook 不存在时退回本地 `useState`。

### client 发现

- `client-modules/src/index.ts:529/721-737`：扫描 Loader entries，读 package.json
  `dsh.client.platform='web'` 与 `exports['./client']`。本包已具备；实际页面加载还需
  profile 里已有该包的 host 行（本任务未改 profile）。

## 5. 关键代码（开关）

```ts
const [localPanel, setLocalPanel] = useState<string | null>(null);
const activePanelId =
  props.usePanelInfo === undefined
    ? localPanel
    : props.usePanelInfo((info) => info.activePanelId);
const select = (panelId: string | null): void => {
  setLocalPanel(panelId);
  ctx.layout.selectPanel(panelId);
};
```

## 6. 关键代码（面板）

```ts
ctx.slots.register({ name: 'main', key: 'caduceus', locale: NS }, (props) => {
  const t = props.t ?? ((key) => FALLBACK[key]);
  return createElement('section', null,
    createElement('h1', null, t('panel.title')),
    createElement('p', null, `${t('panel.version')} ${__CADUCEUS_VERSION__}`),
    createElement('p', null, t('panel.loaded')),
  );
});
```

## 7. 语言

client 通过 dsh web 的 `locale` service 注册 `zh`/`en` 字典，slot 标准 `t` 取文案；
host 插件的 `lang`（Feishu 面）未桥接到浏览器。若要求浏览器文案完全跟随 host `lang`，
需要在 host/client 之间加一条语言 bridge（本版未做，见“未验证/后续”）。

## 8. 未验证项与限制

- **真机 dsh web 加载未验证**：需宿主安装 0.11.0（含 `lib/client.js`）并重启；
  若 profile 没有该包 host 行，client-modules 不会扫描到它。
- 未验证真实 layout store 的 `usePanelInfo` 在 overlay 座位上的值；组件已按标准 prop 写，
  缺失时本地 state 兜底。
- 构建依赖 dsh checkout 的 tsdown（`DSH_TSUNDOWN` 或 `DSH_CHECKOUT` 指定）；本包未新增依赖。
- `usePanelInfo`/`t` 仅按结构声明，未引入 `@deepseek-ai/dsh-client-*` 类型依赖。

## 9. 测试

主包 412 用例保持全绿；client 独立 typecheck：

```text
tsc -p tsconfig.client.json --noEmit → 0
```

artifact 模拟加载（假 `__ModuleLoader__` + React stub）：

```json
{"overlay text":["[ 对话 | 双蛇杖 ]","双蛇杖"],
 "title":"双蛇杖工作台","versionLine":"版本 0.11.0","loaded":"面板已加载"}
```

## 10. 真机待确认（安装 + 重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 开关常驻 | Web 页面底部出现 `[ 对话 | 双蛇杖 ]`，对话/面板切换都在 |
| 2 | 高亮 | 点双蛇杖后按钮高亮；点对话回会话 |
| 3 | main 面板 | 双蛇杖面板显示标题、0.11.0、面板已加载 |
| 4 | 刷新恢复 | 刷新页面后布局 store 的 activePanelId 决定高亮 |
| 5 | 回退 | 若 layout hook 缺失，本地 state 仍能切换 |
