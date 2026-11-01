# 第四十六刀（P0）：私聊回复不再伪装成“话题回复”

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 真机现象

私聊发 `/whoami`，机器人回复带「话题 om_x100…」与「回复话题」按钮。

两个根因：

1. normalize 把 `threadId = message.thread_id ?? message.root_id`，私聊普通消息的
   `root_id`（常等于自身 message_id）被误当话题 id；
2. `#replyText` 只要 `lastInboundMessageId` 存在就 `reply(...)`（引用回复），
   私聊没有 thread 也走了引用。

## 1. 改动

### 1.1 normalize

```ts
// Only a real thread_id makes a topic. In p2p, root_id can equal the
// message id; treating it as threadId produced bogus "topic replies".
const threadId = firstNonEmpty(message.thread_id);
const rootId = firstNonEmpty(message.root_id);
```

`rootId` 仍保留用于诊断，但不再兼任 `threadId`。

### 1.2 #replyText

```ts
if (state.threadId !== undefined && state.lastInboundMessageId !== undefined) {
  await this.#transport.reply(state.chatId, state.lastInboundMessageId,
    { kind: 'text', text }, { threadId: state.threadId });
} else {
  await this.#transport.sendText(state.chatId, text); // 普通新消息，不引用
}
```

### 1.3 #sendNewCard

```ts
if (state.threadId !== undefined && state.lastInboundMessageId !== undefined) {
  return this.#transport.reply(state.chatId, state.lastInboundMessageId,
    { kind: 'card', card }, { threadId: state.threadId });
}
return this.#transport.sendCard(state.chatId, card); // 普通卡片消息
```

话题内仍 reply + `threadId`，不会飘到群主流程。

### 1.4 顺带

- `scripts/smoke.mjs` 的命令表补上 `/whoami`（0.7.0 漏改导致 smoke 红）。
- 版本 0.7.1。

## 2. 测试

原有 305 例保留，新增/更新后共 **308** 全绿：

- 私聊 `/whoami` → sendText，reply 零调用；
- 私聊普通回合的文本通知 → sendText，不引用回复；
- 私聊开交互卡 → sendCard，不 reply；
- 话题 `/whoami` → reply + `threadId=omt_t` + replyTo=入站消息，sendText 零调用；
- `root_id` 存在但 `thread_id` 缺失 → `threadId=undefined`，`rootId` 保留；
- smoke 通过（12 命令）。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 私聊文本 | `/whoami` 回复为普通消息，无“话题”/“回复话题”UI |
| 2 | 私聊卡片 | 过程卡/交互卡为普通卡片消息，不引用 |
| 3 | 话题 | 话题内回复仍落在话题里，不漂到群主流程 |
| 4 | root_id | 私聊事件带 root_id 时 `/whoami` 当前会话不显示话题 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.7.1。
- 交互卡/媒体发送仍复用各自路径；本刀只改文本与新建卡片两条通用分支。
- `docs/DESIGN.md` 未触碰；profile 未改。
