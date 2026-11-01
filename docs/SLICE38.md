# 第三十八刀：选项卡片支持「自己填写」（dsh 答案 `custom`）

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 目标

dsh 的 `AskUserQuestionAnswerItem` 支持 `custom?: string`（自由文本 Other）。
此前只做了选项按钮；本刀补上飞书卡片表单输入，并把文本编码进 `custom`。

飞书卡片 1.0：
- `input` 必须在 `form` 容器内；
- form 内按钮 `action_type: "form_submit"`；
- 回调携带 `action.form_value`（`{ <input name>: "文本" }`）；
- 输入框需客户端 V6.8+，低版本显示降级占位（可接受）。

## 1. 改动

### 1.1 transport

- `CardAction` 新增 `formValue?: Readonly<Record<string,string>>`。
- `normalizeCardAction` 从 `action.form_value` 提取字符串字段，非字符串丢弃；
  没有有效字段时不加 `formValue`。

### 1.2 选项卡结构

单问题卡（无论有没有 options）：

- 原有选项按钮（若有且 ≤4）保留；
- 额外一块 `或自己填：` + `form`：
  ```ts
  {
    tag: 'form',
    name: 'question_form',
    elements: [
      { tag: 'input', name: 'other', max_length: 200, placeholder: {...} },
      {
        tag: 'button', name: 'submit', type: 'primary',
        action_type: 'form_submit',
        text: { tag: 'plain_text', content: '提交' },
        value: { kind: 'question', id, sessionId, questionId, form: true },
      },
    ],
  }
  ```
- 无 options：只有输入框 + 提交按钮；
- `multiSelect: true`：卡片明写 `（多选暂不支持，仅能选一项）`，选项按钮仍按单选处理，
  不静默降级；
- 多问题请求：保持原文本卡（不含逐题表单），提示直接回复文本。

### 1.3 回调与答案

- 普通按钮：`{ answers: [{ id, selected: [label] }] }`（不变）；
- 表单提交：
  - 文本 trim 后为空 → **不 resolve、不删除 pending、不重置超时**；
    同卡 patch 重建并加上 `请填写后再提交`；
  - 非空 → `{ answers: [{ id, selected: [], custom: "<文本>" }] }`；
  - 同卡 patch 终态 `已填写：<文本前 40 字>`。
- 按钮终态仍为 `已选择：<label>`。

## 2. 测试

原有 264 例保留，新增 5 例，共 **269** 全绿：

- form_value 回调 → selected 空、custom 正确、终态 `已填写`；
- 空文本提交 → 不 resolve、pending 保留、卡片提示；随后有效提交成功；
- 无 options → 无选项按钮、只有 input + form_submit；
- multiSelect → 卡片含“多选暂不支持”，按钮仅选一项；
- 长文本 → custom 全文保留，终态只显示前 40 字。
- 另有 transport 归一化断言扩展：`form_value` 提取 + 非字符串丢弃；按钮路径回归由原测试覆盖。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 有选项 + 自定义 | 3 选项卡下方出现输入框与提交按钮；选项按钮仍可用 |
| 2 | 提交自定义 | 输入文字点提交 → 同卡“已填写：…”；dsh 收到 custom |
| 3 | 空提交 | 不提交、不结束；卡片出现“请填写后再提交”，计时不重置 |
| 4 | 无选项 | 只有输入框 + 提交按钮 |
| 5 | 多选 | 卡片显式提示“多选暂不支持，仅能选一项” |
| 6 | 低版本客户端 | 输入框显示降级占位（可接受） |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；真机需重启 0.3.0 后验证。
- 多选、多问题逐题自定义输入仍不支持，卡片已显式说明。
- 表单输入依赖飞书 V6.8+；低版本仅能看占位。
- `docs/DESIGN.md` 未触碰；profile 未改。
