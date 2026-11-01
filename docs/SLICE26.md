# 第二十六刀：`/doctor` 体检报告

状态：**代码与单测完成；需按宿主流程同步并重启后验证**。
本刀未改 `docs/DESIGN.md`、未安装/未重启、未触碰真实数据。

## 0. 背景

已有自检是给日志看的一行。用户要的是能主动跑、能看懂、能拿去求助的体检入口：
`/doctor`（文本分段），以及机器可读的 `/doctor --json`。

## 1. 实现

### 1.1 `src/doctor.ts`

- `DoctorInputs` → `buildDoctorReport()`：逐项 `safeItem`，**任何检查抛错只让该项 ✗**，
  整体永远出报告；拿不到的写 `○` 并给原因。
- 分段：
  - **运行时**：版本（插件/dsh/node）、preset（composed）、工具（首条 request/header，
    无则 pending）、当前会话工具数、sessionTitle 服务、agents 服务；
  - **飞书**：凭证（appId 掩码 + 启动时缓存的 bot 名，不额外调 API）、长连接状态与已运行时长、
    最近一次卡片/消息成功时间与失败次数；
  - **人格**：SOUL 源路径/字节、AGENTS.md 投影块与一致性、旧位置遗留块（仅发现时 `!`）；
  - **会话**：当前 scopeKey/sessionId/preset/history 条数、session-map 版本与可写性（临时写探测）。
- 行格式：` ✓ / ✗ / ○ / ! 名称 · 详情`；结论 `N 项正常 · M 项异常 · K 项跳过`
  （warn 计入正常；空遗留块不占条目）。
- appSecret 从不进入报告；appId 只显示前 7 + 后 4 位。

### 1.2 命令与运行时接线

- 新增 `/doctor [--json]` 命令（parser/spec/help/README/smoke 命令表均已更新）。
- Bridge 提供 session 信息（scopeKey、sessionId、selfcheck 已知 preset/工具数、history 长度）；
  index 注入 `doctorInputs` 收集运行时数据：
  - 版本从 package.json / 安装的 dsh 读取；
  - bot 名与长连接状态由 transport 启动时缓存/上报（不额外请求飞书）；
  - 最近发送成功/失败来自 ReliableTransport 的统计；
  - map 可写性用 `<caduceus 目录>/.doctor-write-probe` 临时写入后删除。
- transport 新增可选 `getBotName/getConnectionStatus/getDeliveryStats`（LarkFeishuApi 缓存
  bot 名与 startedAt；Reliable 记录最近成功时间/类型/失败数）。

## 2. 样例输出（测试构造）

```text
大肥鱼 · 体检（插件 0.1.0，dsh 0.2.1-rc.2，node v22.23.2）

【运行时】
 ✓ 版本 · 插件 0.1.0 / dsh 0.2.1-rc.2 / node v22.23.2
 ✓ preset · standard（已挂载）
 ✓ 工具 · 37 个（来自首条请求）
 ✓ 当前会话工具数 · 37 个
 ✓ 标题服务 · 可用
 ✓ agents 服务 · 可用

【飞书】
 ✓ 凭证 · cli_aa1…dbc1（机器人：伊冯）
 ✓ 长连接 · ready（已运行 3h12m）
 ✓ 卡片编辑权限 · 最近一次卡片成功于 14m 前

【人格】
 ✓ 源 · ~/.agents/SOUL.md（1563B）
 ✓ 投影 · ~/.dsh/AGENTS.md（块存在，与源一致）

【会话】
 ✓ 本会话 · feishu-1793463503786（oc_…\0ou_user，preset=standard，历史 2）
 ✓ 存储 · session-map v5 可写（5 条）

【结论】13 项正常 · 0 项异常 · 0 项跳过
```

## 3. 测试

- 原有 223 例全部保留，新增 5 例，共 **230 例全绿**：
  - 全正常 → 每项 ✓、结论计数正确、文本分段与关键行；
  - 人格不一致 → 投影 ✗、结论含 1 项异常；
  - 某项（sessionTitle getter）抛错 → 该项 ✗ 带错误摘要，其余项正常渲染；
  - `--json` 可解析、含所有分段与项、无 appSecret/secret；
  - 无数据 → tools/connection 等 ○、结论统计 skip；
  - Bridge `/doctor` 文本 + `/doctor --json`，parser `--json`/usage。
- 全部注入式（mkdtemp 人格路径、假 doctorInputs/transport），不碰真实 `~/.dsh`。

## 4. 仍需真机确认（同步并重启后）

| # | 待确认 | 验证方法 |
|:--|:--|:--|
| 1 | 文本报告 | 飞书发 `/doctor`：分段显示运行时/飞书/人格/会话，最后一行结论计数 |
| 2 | 工具数 | 工具行显示 request/header 的真实数字（如 37），未请求时 pending |
| 3 | 飞书 | 凭证显示 appId 掩码 + bot 名；长连接 ready + 已运行时长；最近卡片成功时间/失败数 |
| 4 | 人格 | 源/投影路径与字节；故意改 SOUL 不 sync → 投影 ✗；旧 `~/.agents/AGENTS.md` 有块 → `! 可删除` |
| 5 | 会话 | 当前 sessionId、preset、history 条数；session-map v5 可写与条数 |
| 6 | JSON | `/doctor --json` 可被脚本解析，含全部分段/项，无 appSecret |
| 7 | 容错 | 任一检查抛错只显示该项 ✗，报告仍完整；无数据项 ○ |
| 8 | 版本 | 标题与版本项显示插件/dsh/node 版本 |

## 5. 约束与遗留

- 未改 `docs/DESIGN.md`（工作区该文件有宿主侧未提交改动，本刀未触碰、未提交）。
- 未安装/未重启：安装与重启由宿主侧执行。
- bot 名/连接状态来自启动缓存，不额外调飞书 API；无凭据模式没有 bridge，`/doctor` 不可用。
- 卡片编辑权限没有直接权限查询 API，只能以最近发送成功/失败做代理判断（显示“未验证”）。
- map 可写探测会在 caduceus 目录写一个临时文件后立即删除。
