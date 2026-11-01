# 第二十九刀：整理为可发布状态（dsh-caduceus / MIT）

状态：**仓库已整理为可发布形态；未执行 npm publish（由宿主侧发布），未安装到任何真实 profile。**
本刀未改 `docs/DESIGN.md` 的设计内容：只同步了包名引用，并把旧 README 归档到文末附录。

## 1. 包名与引用

- `package.json.name`：`@artomyuan/dsh-caduceus` → **`dsh-caduceus`**（不带 scope；npm 上该名未占用）。
- `cordis.patch.yml` 两行 name 同步：
  - `dsh-caduceus`
  - `dsh-caduceus/persona`
- 全仓（src 注释、docs/VERIFY、tests、smoke、README、DESIGN 引用）统一替换旧 scope 名；
  `grep -rn "@artomyuan"`（排除依赖/构建产物）为空。

## 2. package.json 元数据

```json
{
  "name": "dsh-caduceus",
  "version": "0.1.0",
  "description": "Feishu/Lark surface plugin for DeepSeek Harness (dsh): one topic per session, SOUL persona sync, streaming process cards, /status and /doctor.",
  "author": "ArtomYuan",
  "repository": { "type": "git", "url": "https://github.com/ArtomYuan/dsh-caduceus.git" },
  "homepage": "https://github.com/ArtomYuan/dsh-caduceus#readme",
  "bugs": { "url": "https://github.com/ArtomYuan/dsh-caduceus/issues" },
  "keywords": ["dsh", "deepseek-harness", "feishu", "lark", "gateway", "surface", "bundle", "plugin", "dsh-plugin", "cordis", "chat"],
  "engines": { "node": ">=22.13", "dsh": ">=0.2.1-rc.2" },
  "files": ["dist/", "cordis.patch.yml", "README.md", "LICENSE"],
  "scripts": { "prepare": "tsc -p tsconfig.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "compatibility": { "dshReleases": { "0.2.1-rc.2": "compatible" } }
  },
  "license": "MIT"
}
```

- **注意：GitHub 仓库尚未创建**，`repository/homepage/bugs` 先指向 `https://github.com/ArtomYuan/dsh-caduceus`，建仓后核对 URL。
- `prepare` 直接调用 devDependency 里的 `tsc`；git 安装时 npm 会先装 devDependencies 再跑 prepare。
- `files` 白名单确保 tgz 只带运行产物与说明/许可。

## 3. LICENSE

新增根目录 `LICENSE`：MIT 全文，版权行 `Copyright (c) 2026 ArtomYuan`。

## 4. README 拆层

- 根 `README.md` 重写为**用户文档**：定位 / 安装（npm 与 tgz 两种）/ 配置表 / 11 条命令表 / 故障排查（`/doctor`、日志路径）/ 许可。
- 旧 README 原文（切片历史、设计细节、验收清单）**完整归档到 `docs/DESIGN.md` 文末附录**
  “附录：旧 README（用户文档归档，2026-11）”，未删除任何内容；
  该提交的 DESIGN diff 只包含“包名引用替换 + 附录”，宿主在工作区的既有设计修订保持未暂存状态。

## 5. 打包自检

- 干净构建后 `npm pack`：**76 个文件**，仅包含：
  - `dist/**`（当前源码编译产物）
  - `cordis.patch.yml`
  - `README.md`
  - `LICENSE`
  - `package.json`
- 不含 `src/`、`test/`、`docs/`、`node_modules/`、`.test-dist/`。
- 旧构建残留（如已删除的 pin-store/status-card 产物）在打包前通过 `rm -rf dist && npm run build` 清理。

## 6. 隔离安装实测

在临时 `DSH_HOME` + 临时 `HOME` 下执行（**未触碰 `~/.dsh/profiles`**）：

```bash
DSH_HOME=$(mktemp -d) HOME=$DSH_HOME/home dsh plugin --profile demo --version  # 初始化 demo
# pnpm 11 默认拦截依赖构建，protobufjs 需要放行（仅临时 profile）：
#   pnpm-workspace.yaml: onlyBuiltDependencies: [protobufjs] + dangerouslyAllowAllBuilds: true
#   .npmrc: only-built-dependencies[]=protobufjs + dangerously-allow-all-builds=true
dsh plugin --profile demo add ./dsh-caduceus-0.1.0.tgz
dsh --profile demo --dump-config | grep -c dsh-caduceus
```

实测：

- `dsh plugin add` 退出码 **0**（pnpm 成功安装并执行 protobufjs postinstall）；
- `dump-config` 中 `grep -c dsh-caduceus` = **3**；
- 组合配置包含：
  - `- id: caduceus-gateway`
  - `- id: caduceus-persona`

## 7. 约束与遗留

- 未执行 `npm publish`，未安装到真实 profile；发布由宿主侧执行。
- 仓库远程地址为预设值，**GitHub 仓库待建**。
- 临时 profile 的 pnpm 构建放行只用于验证环境；真实安装时的依赖构建策略由宿主/用户环境决定。
- `docs/DESIGN.md` 的宿主未提交设计修订仍未暂存，提交中只有包名替换 + README 归档附录。
- 包名与版本为 `dsh-caduceus@0.1.0`；后续发布前如需改版本，改 `package.json.version` 后重新打包。
