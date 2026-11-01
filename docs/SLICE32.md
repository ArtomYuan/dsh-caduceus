# 第三十二刀（P0）：README 双语命令表断言收紧

状态：**仅测试与文档标题改动；无代码逻辑改动，未重启。**

## 0. 背景

用户看到的是 `0c25703` 上的失败：
`README 命令表与 parse.ts 实际支持的命令完全一致` → `README 缺少 ## 命令 段落`。
原因：断言只读 `README.md` 且找中文标题；英文主档已改成 `## Commands`，中文镜像在 `README.zh.md`。

当前工作区其实已在 `b01d4da` 做过初步双文件校验（236 绿），但标题匹配较宽松
（`## 命令` 或 `## Commands` 任一即可）。本刀按 P0 要求收紧为**固定标题、分别校验两份文件**。

## 1. 改动

### 1.1 `README.zh.md`

- 中文命令段标题从 `## Commands（命令）` 改为 **`## 命令`**，与断言约定一致。
- 内容/命令表本身不变。

### 1.2 `test/commands.test.ts`

新增严格校验（替代原有宽松循环）：

- 两份文件都必须存在（缺失直接失败并写明文件名）；
- `README.md` 必须含精确的 `## Commands` 段落；
- `README.zh.md` 必须含精确的 `## 命令` 段落；
- 各自取该段落（到下一个 `## ` 为止）解析 `| \`/xxx\`` 命令名；
- 与 `COMMAND_NAMES` 逐项比较：
  - 缺命令 → `README.zh.md 缺 /doctor` 形式；
  - 多命令 → `README.zh.md 多 /xxx` 形式；
  - 最后再比较完整排序集合。
- 测试数量不变（仍 236，无删减）。

## 2. 失败路径实测

临时删除 `README.zh.md` 的 `/doctor [--json]` 行后运行：

```text
not ok 8 - README.md / README.zh.md 命令表与 parse.ts 实际支持的命令完全一致
error: |-
  README.zh.md 缺 /doctor
  + actual - expected
  + [ 'doctor' ]
  - []
```

验证后已恢复原文件（`mv .zh.bak`），再次全量：

```text
# tests 236 / # pass 236 / # fail 0
```

## 3. 验证

- `tsc -p tsconfig.json --noEmit`：0
- `tsc -p tsconfig.test.json --noEmit`：0
- `npm test`：236 全绿（数量未减少）
- `npm run smoke`：通过

## 4. 约束

- 未改任何运行代码；未改 profile；未重启；未发布。
- 未改 `docs/DESIGN.md`。
