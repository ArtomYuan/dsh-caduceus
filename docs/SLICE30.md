# 第三十刀：把安装坑写进 README（pnpm 11 拦截 protobufjs）

状态：**仅文档改动；未改任何代码、未改 profile、未重启。**
本刀未改 `docs/DESIGN.md`。

## 0. 实测证据（pnpm 11.7.0）

- `dsh plugin --profile demo add ./dsh-caduceus-0.1.0.tgz`
  → `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: protobufjs@7.6.6`，安装失败；
- `... --allow-build protobufjs`（空格）→ `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`，失败；
- `... --allow-build=protobufjs`（等号）→ 成功，`dump-config` 里能看到 3 处 dsh-caduceus。

原因：`protobufjs` 是飞书 SDK 的传递依赖；pnpm ≥10 默认不执行依赖包的安装/构建脚本，
除非显式放行。

## 1. README 改动

`## 安装` 重写为三种路径 + 坑提示：

1. 一次性命令行（推荐）：
   `dsh plugin --profile web add dsh-caduceus --allow-build=protobufjs`
2. 先授权再装：profile 的 `pnpm-workspace.yaml` 加
   ```yaml
   onlyBuiltDependencies:
     - protobufjs
   ```
   之后 `dsh plugin --profile web add dsh-caduceus` 即可；
3. 本地 tgz：`npm pack` 后
   `dsh plugin --profile web add ./dsh-caduceus-0.1.0.tgz --allow-build=protobufjs`。

坑提示原文：
- flag 必须用等号；空格形式会报 `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`；
- 为什么需要放行（protobufjs 是飞书 SDK 传递依赖，pnpm ≥10 默认不跑依赖构建脚本）；
- 验证：`dsh --profile web --dump-config | grep dsh-caduceus` 至少 2 行。

另外 `## 故障排查` 补一条：启动日志无 `feishu long connection started` 时先跑 `/doctor`。

## 2. 代码

无代码改动。仅验证既有代码仍健康：

- 两份 tsconfig `--noEmit` 均 0；
- `npm test` 236 全绿；
- `npm run smoke` 通过。

## 3. 约束与遗留

- 未执行 npm publish、未安装到真实 profile、未重启。
- 文档里的 `web` 是举例 profile 名；宿主按实际 profile 替换。
- 若宿主使用 pnpm <10，则不会遇到 build-script 拦截，命令仍兼容。
