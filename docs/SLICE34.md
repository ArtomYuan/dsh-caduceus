# 第三十四刀：caduceus 会话默认审批策略改为 `ask`

状态：**代码与单测完成；需同步并重启后真机验证。**
本刀未改 `docs/DESIGN.md`、未改 profile、未安装/未重启、未碰真实数据。

## 0. 背景

profile 的 `defaultPreset: danger-full-access` 对应 `approval: never`，实测会话日志是
`{"policy":"never"}`，因此审批 waterfall 不会被触发，交互审批卡永远不弹。
IM 场景人类在场，危险操作应弹卡确认。

## 1. 改动

- `GatewayConfig` 新增 `approvalPolicy?: 'ask' | 'never'`，默认常量
  `DEFAULT_APPROVAL_POLICY = 'ask'`；schema 用 union 校验。
- Bridge 新增 `ApprovalServiceLike`（只含 `setPolicy(agent, policy)`）与
  `approvalProvider?: () => ApprovalServiceLike | undefined`、`approvalPolicy?`（缺省 `ask`）。
- 在以下成功点惰性取服务并 `setPolicy(agent, policy)`：
  - `#createAgent` 创建成功（ownership 写完）后；
  - `#resolveAgent` resume 成功后；
  - `/resume` 的 `#switchSession` resume 成功后。
- 日志：
  - 每次创建/恢复打 `agent approval policy=<policy>`；
  - 服务缺失只 warn 一次：`approval service unavailable; session approval policy not applied`；
  - `setPolicy` 抛错 → warn（含策略与错误），会话继续可用。
- 版本 0.2.1；README（英/中）配置表新增 `approvalPolicy`。
- 未改任何会话存储/日志重放逻辑；不覆盖已有会话持久化的 policy，只在 agent 生命周期起点设置。

## 2. 测试

新增 5 例（原有 250 全部保留，共 **255**）：

- 默认创建 → `setPolicy(agent, 'ask')` 一次，日志有 `agent approval policy=ask`；
- 配置 `never` → 传 `never`；
- 服务缺失 → 两次创建不抛、warn 仅 1 条；
- resume 路径（switch session）→ 恢复的 agent 同样调用 `setPolicy('ask')`；
- 配置默认值：`DEFAULT_APPROVAL_POLICY='ask'`，`resolveGatewayConfig` 默认/覆盖。

## 3. 真机待确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 默认策略 | 启动后发一句话，日志出现 `agent approval policy=ask` |
| 2 | 审批卡 | 触发需要审批的工具调用，飞书收到「审批请求 · <tool>」，允许一次后继续 |
| 3 | 拒绝/超时 | 拒绝 → 工具拒绝；不点 5 分钟 → 卡片「已过期」并 cancelled |
| 4 | 配置覆盖 | 把 `approvalPolicy` 设为 `never` 重启：会话日志 policy=never，不再弹卡 |
| 5 | 失败安全 | 服务缺失/报错时只 warn，聊天与工具执行不受阻 |

## 4. 约束与遗留

- 未 npm publish、未安装、未重启；profile 未改。
- 只对 caduceus 自己创建/恢复的 agent 设置策略，不触碰其他插件/宿主 agent。
- 既有会话若之前显式持久化过 `approval/policy` override，dsh 的“最后事件优先”语义可能保留旧值；
  本包不在每轮强行覆盖。
