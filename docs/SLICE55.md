# 第五十五刀：导出文件进缓存目录 + 启动清理

状态：**代码与单测完成；需同步并重启后真机验证。**
未改 dsh 源码/profile、未重启、未安装。

## 1. 背景

`/export` 之前写进会话工作区，每次 ~238KB，从不删除，已积文件。
参考 Hermes：中间文件进专属缓存目录，网关启动时清理超龄文件。

## 2. 改动

### 2.1 缓存目录与文件名

- 导出目录：`$DSH_HOME/caduceus/cache/exports/`
  （`defaultExportCacheDir()`，启动时 `mkdir -p`）；
- 文件名：`caduceus-<scopeKind>-<sessionTail8>-<yyyyMMdd-HHmmss>.<ext>`，
  可读、不以点开头；例
  `caduceus-p2p-93650911-20261103-123011.md`；
- markdown 与 `--json` 共用同一命名/目录规则。

### 2.2 启动清理

- 配置 `exportCacheMaxAgeHours`（默认 24，schema 同步）；
- 插件启动时（bridge 建好后）确保目录存在并跑一次
  `cleanupExportCache(dir, maxAgeHours, now, logger)`；
- 删除 mtime 超龄的 `caduceus-*` 文件，日志：
  `export cache: removed=N kept=M`；
- 目录不存在不报；读/删错误只 warn，不抛；
- 不清理用户工作区既有旧文件（本刀不删）。

### 2.3 上传与文件保留

- 上传成功**不删除**导出文件（交给启动清理）；
- 上传失败**保留**文件，warn 日志带完整路径：
  `media send failed for <name> (<full path>): <reason>`；
- 便于排查“生成成功但发不出”。

### 2.4 版本

0.10.2；README 配置表加 `exportCacheMaxAgeHours`。

## 3. 测试

原有 368 例保留，新增 9 例，共 **377** 全绿：

- 路径在 `$DSH_HOME/caduceus/cache/exports` 下、不在会话 cwd；
- 文件名不以点开头、含 session 尾 8 与时间戳（markdown/jsonl）；
- 清理：超龄删、未超龄留、边界内留；
- 目录不存在不崩；
- 读目录抛错只 warn；
- 日志计数 `removed/kept`；
- 非 `caduceus-*` 文件不动；
- 上传成功文件保留；
- 上传失败文件保留且 warn 全路径。

## 4. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 路径 | `/export` 后文件在 `~/.dsh/caduceus/cache/exports`，不在 workspace |
| 2 | 命名 | 文件名 `caduceus-<kind>-<tail8>-<时间>.<ext>`，不以点开头 |
| 3 | 清理 | 启动日志出现 `export cache: removed=N kept=M` |
| 4 | 超龄 | 24h 前的导出文件启动后被删 |
| 5 | 成功保留 | `/export` 发送成功后文件仍在 cache |
| 6 | 失败保留 | 上传失败后文件仍在 cache，日志有完整路径 |

## 5. 约束与遗留

- 未 npm publish、未安装、未重启；真机需同步 dist 并重启。
- 用户工作区里已有的旧导出文件不删，留给宿主/用户另行处理。
- 清理仅在启动时执行一次；运行期间不主动删。
- `docs/DESIGN.md` 未触碰；profile 未改。
