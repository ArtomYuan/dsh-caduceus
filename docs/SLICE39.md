# 第三十九刀（P0）：命令解析容忍 @ 提及前缀

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机证据

话题里用户发 `@_user_1 /stop`（飞书把 @ 转成占位符），gate 日志显示 accept，
但没有任何回复。原因：`parseCommand` 只看 `trimmed.startsWith('/')`，
`@` 开头直接 passthrough 给 agent，命令未执行。

## 1. 改动

### 1.1 共用剥离函数

新增 `src/mentions.ts`：

```ts
const LEADING_MENTIONS = /^\s*(?:@\S+\s*)+/;
export function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS, '');
}
```

- 只剥**开头**的一串 `@...`（覆盖 `@_user_1` 与真实 `@昵称`）；
- 正文里的 `@` 不动；
- 顺带导出 `hasLeadingMentions`。

### 1.2 parseCommand

```ts
const trimmed = stripLeadingMentions(raw).trim();
if (!trimmed.startsWith('/')) return { kind: 'passthrough', raw };
```

- 剥离后以 `/` 开头才当命令；
- 否则仍 passthrough，且 `raw` 保持原始字节（含 @）；
- 未知 `/` 命令也保持原样 passthrough；
- usage/helpText 未改。

### 1.3 正文归一化

`normalizeMessageEvent` 在移除 `<at>` 标签、统一换行、trim 之后：

```ts
text = stripLeadingMentions(text).trim();
if (text.length === 0) return undefined;
```

- `@_user_1 你好` → 正文 `你好`；
- `你好 @_user_1 再见` → 原样保留；
- 避免把占位符带进 agent prompt；被提及本体仍通过 `mentions` 数组供 gate 使用。

## 2. 测试

原有 269 例保留，新增 2 组断言，共 **271** 全绿：

- `@_user_1 /stop` → `stop`；
- `@_user_1 @_user_2 /doctor --json` → `doctor, json=true`；
- `@_user_1 /rename 新标题` → `rename, title=新标题`；
- `@张三 /status` → `status`；
- `随便说 /stop` / `@_user_1 随便说 /stop` → passthrough 且 raw 原文不变；
- 归一化：前导提及剥离、正文 @ 保留、多个前导提及全部剥离。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 话题 @ 命令 | 话题里 `@机器人 /stop` 能收到中断/状态回复 |
| 2 | 多提及命令 | `@x @y /doctor` 能执行 |
| 3 | 普通正文 | `@机器人 你好` 的 prompt 不含 `@_user_1` 前缀 |
| 4 | 正文 @ | “你好 @某人 再见” 原样保留 |
| 5 | 非命令 | “随便说 /stop” 仍当普通消息，不误执行 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.3.1。
- 剥离规则仅覆盖开头空白 + `@\S+` 串；正文中的提及不变。
- `docs/DESIGN.md` 未触碰；profile 未改。
