# 第四十五刀（P0 安全）：身份分级（管理员白名单）+ `/whoami`

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 背景

当前 `danger-full-access` 沙箱 + 群里任意 @ 机器人都能驱动 agent＝任何群成员可让机器执行命令。
需要管理员白名单做第一层身份分级。

## 1. 实现

### 1.1 配置

- `admins: string[]`（open_id 列表）：
  - 空数组 = 访问控制关闭（向后兼容），启动 WARN
    `access control disabled (no admins configured)`；
  - 非空 = 开启，仅名单内 sender 可执行。
- `accessControlWarning(admins)` 导出便于测试启动日志。

### 1.2 强制点（bridge.handleInbound）

在 `gate accept` 之后、`#queue.run`/建会话之前：

```ts
if (!this.#isAdmin(message.senderOpenId) && !this.#isPublicCommand(message.text)) {
  const state = this.#stateFor(message);
  state.lastInboundMessageId = message.messageId;
  state.ownerOpenId = message.senderOpenId;
  this.#logger.info(
    `gate drop: not-admin sender=${message.senderOpenId.slice(0, 12) || '-'}`,
  );
  await this.#replyText(state, '访客无执行权限。');
  return;
}
```

- 文本回复，不建持久会话、不调 agent、不发任何卡片；
- `/help`、`/whoami` 例外放行（`#isPublicCommand`，支持前导 @）；
- 其他命令与普通消息一样被拒。

### 1.3 `/whoami`

```
你的 open_id：ou_xxx
当前会话：oc_xxx[话题 omt_xxx]
身份：管理员 / 访客
```

- 无话题时省略 `[话题 …]`；
- 身份：admins 为空（分级关闭）或 sender 在名单内 → 管理员，否则访客；
- 加入 COMMAND_SPECS/COMMAND_NAMES，`/help` 自动包含。

### 1.4 `/doctor`

运行时段新增：

- `✓ 访问控制 · 开启（N 人）`；
- `○ 访问控制 · 关闭（未配置 admins）`。

index 的 doctorInputs 传 `access: { enabled, adminCount }`。

### 1.5 README

命令表加 `/whoami`，What you get 改为 12 条命令；配置表加 `admins` 行。
版本 0.7.0。

## 2. 测试

原有 299 例保留，新增 6 例，共 **305** 全绿：

- admins=[] → 任意发送者放行；
- admins=[A]：非管理员 /stop 与普通消息被拒，零会话/零 agent/零卡片，日志 `gate drop: not-admin`；
- 非管理员 /help 与 /whoami 放行；/whoami 显示 open_id/chatId/访客；
- 管理员 /whoami 显示管理员与话题；
- `/doctor` 开启/关闭各一行；
- admins 配置默认/覆盖、启动 warning。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 分级关闭 | admins 不配：启动 WARN，任何人可用 |
| 2 | 名单生效 | 配置 admins 后，非名单用户发消息只收到「访客无执行权限。」，无卡片/无会话 |
| 3 | 公共命令 | 访客 `/help`、`/whoami` 能正常回复 |
| 4 | 管理员 | 名单内用户正常执行；`/whoami` 显示管理员 |
| 5 | /doctor | 显示 `访问控制 · 开启（N 人）` 或 `关闭（未配置 admins）` |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.7.0。
- 访问控制是白名单层，不替代沙箱；`danger-full-access` 仍是高风险配置。
- 未配置 admins 时保持旧行为（全放行），但会 WARN 提醒。
- `docs/DESIGN.md` 未触碰；profile 未改。
