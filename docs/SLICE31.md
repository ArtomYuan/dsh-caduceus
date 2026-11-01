# 第三十一刀：README 重写为英文主档 + 中文镜像（0.1.1）

状态：**仅文档与包元数据改动；未改代码逻辑、未改 profile、未重启。**
本刀未改 `docs/DESIGN.md`。

## 0. 参考惯例

参照 dsh 生态高星仓库（dsh-context / ds-harness-remote）的首屏结构：
语言切换行 → 徽章 → 一句话定位 + 作用域 → “长什么样” → What you get → Requirements → Install →
Configure → Commands → Troubleshooting → Limitations → Docs → License。

不伪造截图（用 fenced text 示意），不写自夸文案；徽章只用真实可用的 npm version / GitHub stars / license。

## 1. 两个文件

- `README.md`：英文主档（npm 主页与 GitHub 首屏）。
- `README.zh.md`：中文镜像，内容不缩写。
- 各自顶部有语言切换：英文档 `[中文](README.zh.md) / **English**`，
  中文档 `[English](README.md) / **中文**`。
- `README.md` 徽章：
  - npm version `https://img.shields.io/npm/v/dsh-caduceus.svg`
  - GitHub stars `ArtomYuan/dsh-caduceus`
  - License MIT

## 2. 结构

- **一句话定位（粗体）** + 作用域声明（引擎仍是 dsh，loop/tools/sandbox/skills 不变）。
- **What you get**：6 条粗体功能（一 scope 一会话、可见标题、每回合一张卡、11 命令、
  人格自动同步、可观测性）。
- **Looks like**：文本示意（过程卡状态行/最近事件/正文卡内滚动/收尾定格），并注明不是截图。
- **Requirements**：dsh ≥0.2.1-rc.2、Node ≥22.13、pnpm ≥10、飞书应用一路长连接消费者。
- **Install**：CLI 三步（装包带 `--allow-build=protobufjs` → 填 appId/appSecret → 宿主重启看日志），
  保留 pnpm ≥10 的坑（等号必需、空格报 `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`、
  否则 `ERR_PNPM_IGNORED_BUILDS`、`pnpm-workspace.yaml` 预授权、dump-config 验证 ≥2 行）。
- **Configure**：8 个配置项（凭证、defaultCwd、groupSessionsPerUser、busyMode、
  cardThrottleMs、personaAutoSync、agentPreset、logLevel）。
- **Commands**：11 条命令完整表。
- **Troubleshooting**：无长连接日志先 `/doctor`、日志路径、对话内自检提示、preset/persona 失败、
  pnpm 安装失败。
- **Limitations**：一路长连接、命令回合 pending、人格投影目标与遗留块不删、日志轮转、
  无独立 Web UI 向导。
- **Docs / License**：DESIGN、VERIFY、SLICE 归档；MIT。

## 3. 包元数据

- `package.json.version`：0.1.0 → **0.1.1**（README 重写随之发一版）。
- `package.json.files` 增加 **`README.zh.md`**（此前只打包 README.md）。
- 无代码逻辑改动；仅把既有“README 命令表与 parse 一致”测试改为同时检查
  `README.md`/`README.zh.md`（英文标题 `## Commands` 与中文 `## Commands（命令）` 都接受），
  覆盖从一份 README 扩到两份，不弱化断言。

## 4. 验证

- 两份 tsconfig `--noEmit` 均 0；
- `npm test` 236 全绿（README 双语命令表断言覆盖两份文件）；
- `npm run smoke` 通过；
- `npm pack --dry-run` 包含 `README.md`、`README.zh.md`、`LICENSE`、`cordis.patch.yml`、`dist/` 与
  `package.json`，不含 src/test/docs。

## 5. 约束与遗留

- 未 npm publish、未安装到真实 profile、未重启。
- GitHub 仓库仍待创建（徽章/链接使用预设地址）。
- 文档中 `web` 是示例 profile 名，宿主按实际替换。
