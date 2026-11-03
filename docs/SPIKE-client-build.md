# SPIKE：第三方插件 client 半构建与加载探针

状态：**构建成功；artifact 加载契约已验证；dsh web 端到端加载未验（受“不改 profile”约束）。**
代码只落在 `spike/client-probe/`，不进主包构建/测试。

## 结论先行

| 问题 | 结论 |
|:--|:--|
| 1. 非 dsh 仓库内的包能否构建 `lib/client.js` 并被 `dsh web` 加载？ | **能构建**。加载路径在源码上成立；端到端加载需要 profile 里有一行 Loader 行，本探针未改 profile，因此只验证到 artifact 契约。 |
| 2. 最小文件/字段？ | `package.json` 的 `dsh.client.platform="web"` + `exports["./client"]`，一个 client 入口，tsdown 配 closure-factory banner/footer；真正挂载还需 profile bundle patch 行。 |
| 3. web 如何发现/加载？ | 看 **package.json 的 `dsh.client`**，不是看 bundle patch 行内容。bundle patch 只负责把 host 行装进 Loader；client-modules 扫描 Loader entries，再读那个包的 package.json。 |

## 构建

命令（在探针目录内，使用本机 dsh 自带的 tsdown，不安装）：

```bash
cd spike/client-probe
node /home/artom/.dsh/node_modules/tsdown/dist/run.mjs --config tsdown.config.mjs
```

真实产物：

```text
$ ls -l lib
-rw-rw-r-- 1 artom artom 2122 Nov  4 02:17 client.js
-rw-rw-r-- 1 artom artom 1560 Nov  4 02:17 client.js.map
-rw-rw-r-- 1 artom artom  144 Nov  4 02:17 index.js
```

`lib/client.js` 开头/结尾符合 loader 契约：

```js
window.__ModuleLoader__.load({
	id: "caduceus-client-probe",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		...
		return module.exports;
	}
});
```

验证结果（`node verify-load.mjs`）：

```json
{
  "artifact": "caduceus-client-probe",
  "manifest": { "dshClient": { "platform": "web" }, "clientExport": "./lib/client.js" },
  "inject": ["slots"],
  "slot": "shell.overlay",
  "label": "caduceus client probe",
  "position": "fixed"
}
```

## 最小文件与字段

`spike/client-probe/package.json`：

- `"type": "module"`
- `"exports": { ".": "./lib/index.js", "./client": { "default": "./lib/client.js" } }`
- `"dsh": { "client": { "platform": "web" } }`
- host 半入口 `lib/index.js`（真实加载时 Loader 行需要它；本探针只构建空 `apply`）。

`src/client/index.ts`：导出 `inject = ['slots']` 与 `apply(ctx)`；
`apply` 内 `ctx.effect(() => ctx.slots.register({ name: 'shell.overlay' }, ProbeLabel), ...)`。

`tsdown.config.mjs`：

- 两个 config：host ESM → `lib/index.js`；client CJS/browser → `lib/client.js`；
- client 用 `banner`/`footer` 包成 `window.__ModuleLoader__.load({id, factory})`；
- `deps.neverBundle: ['react']`（模块表提供 react）、`sourcemap: true`；
- `outExtensions: () => ({ js: '.js' })` 固定文件名。

## 源码依据

### client 半如何被发现

- `packages/client/modules/src/index.ts:2-3`：包说明就是“扫描 host Loader entries，找声明 `dsh.client` 的包”。
- 同文件 `:529`：激活时遍历 `ctx.loader.entries()`，每个 entry name 进 dirty 集。
- 同文件 `:876-880`：增量刷新同样遍历 `ctx.loader.entries()`，只处理有 fiber、未 disabled 的 entry。
- 同文件 `:721-737`：读取该 entry 对应包的 `package.json`，取 `pkg.dsh.client`，要求 `platform === 'web'`；
  再调 `clientExportOf(pkg.exports)` 取 `exports["./client"]` 的路径。
- 同文件 `:176-185`：`exports["./client"]` 可为字符串，或对象里的 `default` 字符串；否则报
  `declares dsh.client but exports no "./client" bundle`（`:734`）。

### 如何进入页面

- `packages/client/modules/src/index.ts:545-547`：把组合后的 boot graph 注入 web 页面 index。
- `packages/client/web/src/boot.ts:69`：浏览器读 `window.__DSH_BOOT__` 创建 module system。
- `apps/web/src/main.ts:3`：`AppWebEntry` 启动 shell。

### bundle patch 的角色

- `packages/bundle/web-app/cordis.patch.yml:42-44`：注释明确“`dsh.client` rows 是 modules node half 扫描进
  `window.__DSH_BOOT__` 的浏览器名册；modules 行同时是 host 行”。
- 同文件 `:170-177`：浏览器插件 roster 是 `insert` 出来的 Loader 行。
- `packages/bundle/web-app/package.json:37-38`：bundle 通过 `dsh.bundle.patch` 声明 patch 文件。

结论：**bundle patch 不携带 client 路径**；它只创建 Loader entry。client 的半边由该 entry 解析到的
package.json 里的 `dsh.client` + `exports['./client']` 决定。所以第三方包要真正被加载，除了自身 manifest，
还必须被某个 profile/bundle patch 作为 host 行 insert（或等价 Loader 行）——这是 profile 配置，不是包内字段。

## 可行性判定

**可行，但需额外条件：**

1. 包内：`dsh.client.platform="web"`、`exports['./client']`、loader 格式的 `lib/client.js`；
2. 包外：profile 的 `cordis.patch.yml` 增加该包的 host 行（`id`/`name`），使 Loader 有 entry；
3. 宿主重启 dsh（本次未做）。

未验证项：真实 `dsh web` 页面加载。原因：硬约束禁止改 profile、重启；本探针通过假
`__ModuleLoader__` 证明 artifact 可执行、`apply` 可注册 `shell.overlay`，并给出源码级发现路径。

## 踩到的构建问题（供下一步）

- 探针的 tsdown 配置最初用 `defineConfig` 从 `tsdown` 导入；包在 dsh 的 node_modules 下，探针目录无法解析，
  改用纯 ESM 数组配置。
- tsdown 0.22.2 在 Node 22.23 下加载 `.ts` 配置报 “known Node.js bug”；改 `.mjs` 解决。
- 默认 CJS 输出 `.cjs`、ESM 输出 `.mjs`；用 `outExtensions` 固定 `.js` 才能对齐 `exports['./client']` 路径。
- 共享 `packages/client/tsdown.client.ts` 预设依赖 dsh workspace 的 package glob（`workspaceManifest`），
  仓外第三方包不能直接复用；本探针用等价的最小 banner/footer 复刻 closure-factory 契约。

## 下一步建议

- 正式第三方 client 插件：在仓库内独立 package（自己的 package.json/tsdown），产出同样 closure-factory artifact；
- 在 profile 的 bundle patch 增加一行 host 行后重启验证真机加载；
- 若要复用 dsh 的 shared preset，需要把包放进 dsh workspace 或抽出一个可独立安装的 build helper；
- 本次探针不纳入 `npm test`/`tsc`，`lib/` 已在 `spike/client-probe/.gitignore` 忽略。
