# 工作台包协议（dsh-caduceus）

当前版本：0.12.0

本文件是 dsh 工作台插件包的交付纪律；不替代 README 的用户用法。

## 1. 包协议

一个可被 dsh web 发现的插件包必须同时满足：

| 字段/产物 | 要求 |
|:--|:--|
| `package.json` | `name`、`version`、`type: module` |
| `dsh.bundle.patch` | 指向 bundle patch（本包 `./cordis.patch.yml`），供 Loader 装 host 行 |
| `dsh.client.platform` | 必须是 `"web"`；client 半才是浏览器行 |
| `exports['./client']` | 可解析到 client 产物；本包 `./lib/client.js` |
| client 产物 | 首行必须是 `window.__ModuleLoader__.load({ id, factory })` 的 closure-factory 形式 |
| host 入口 | `main` / `exports['.']` 指向 host 半；client 不可依赖 host 运行时 |

client-modules 扫描的是 **host Loader entries 对应包的 package.json**（`dsh.client`
与 `exports['./client']`），不是 bundle patch 行里的路径。patch 只负责让 Loader
有这一行；没有 host 行就不会有 client。

## 2. 安装 / 卸载

### 安装

```bash
dsh plugin --profile web add dsh-caduceus \
  --allow-build=protobufjs \
  --config.minimumReleaseAge=0
```

- `--allow-build=protobufjs`：Feishu SDK 的传递依赖需要构建脚本；用等号形式。
- **`--config.minimumReleaseAge=0`**：pnpm/dsh 的发布年龄门槛会拦住刚发布的版本，
  报 `ERR_PNPM_MINIMUM_RELEASE_AGE` 一类错误；临时置 0 再安装。
- 确认：`dsh --profile web --dump-config | grep dsh-caduceus`（至少 2 行）。
- 重启由宿主完成；插件不自行重启/装包。

### 卸载

```bash
dsh plugin --profile web remove dsh-caduceus
```

然后从 profile 的 `cordis.patch.yml` 删除 `caduceus-gateway` host 行（若手工加过），
清理缓存 `$DSH_HOME/caduceus/`，再重启。

## 3. 权限与已知限制

- dsh 的 `main` / `main.*` / `shell.overlay` 是宿主已占用的 single 槽；插件不得再注册，
  否则 entry failed。本包只使用 list 槽：`conversation.session.header.actions`、
  `settings.general.item`。
- 本版没有 main 面板；抽屉由 client 自己用 fixed DOM 渲染。
- 卡片实体编辑有平台上限（≤20 次）；插件内部过程卡已节流。
- 一个飞书应用只能有一路长连接消费者；client 半不改变此限制。
- client 文案由 dsh web 的 `locale` service 提供 zh/en；host 插件 `lang` 通过
  `__CADUCEUS_CLIENT_CONFIG__` 只读暴露，设置页本版只展示不写入。
- 安装/卸载/重启均由宿主执行；插件自身不触碰 profile。

## 4. 验收清单

| # | 检查项 | 怎么验 | 证据形式 |
|:--|:--|:--|:--|
| 1 | 包字段齐全 | `npm run check` | 命令输出 `N passed, 0 failed` |
| 2 | client 产物存在且首行正确 | `head -1 lib/client.js` | 输出 `window.__ModuleLoader__.load({` |
| 3 | 版本三处一致 | `npm run check` | 输出 version 一致 |
| 4 | host 已被 Loader 装载 | `dsh --profile web --dump-config \| grep dsh-caduceus` | 至少 2 行 |
| 5 | 页面出现 header 按钮 | 打开会话，看右上方「双蛇杖」 | 截图 |
| 6 | 抽屉显示版本/会话/面板已加载 | 点按钮 | 截图（含 sessionId） |
| 7 | 设置页只读行 | WebUI Settings → General 看双蛇杖行 | 截图（lang/metrics/busyMode） |
| 8 | 失败可诊断 | 删 `lib/client.js` 后打开页面 | 浏览器 console 的 entry failed 报错 |

## 5. 状态语义

严格区分四种状态，不能互相替代：

1. **已提交（committed）**：commit 在分支上，不代表可用。
2. **已合并（merged）**：进入发布分支，仍不代表已发布。
3. **已发布（released）**：版本已 push/tag/可用源，仍不代表已安装。
4. **已安装（installed）**：profile 里有该版本，仍不代表页面可见。
5. **已验证（verified）**：安装 + 重启 + 真机验收清单有证据，才算可见可用。

报告时必须写清卡在哪一层；只有 commit 或 push 时不得声称“已生效”。
