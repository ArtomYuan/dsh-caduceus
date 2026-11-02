# dsh-caduceus

[中文](README.zh.md) / **English**

[![npm version](https://img.shields.io/npm/v/dsh-caduceus.svg)](https://www.npmjs.com/package/dsh-caduceus)
[![GitHub stars](https://img.shields.io/github/stars/ArtomYuan/dsh-caduceus.svg?style=social)](https://github.com/ArtomYuan/dsh-caduceus)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Use DeepSeek Harness in Feishu/Lark the way you use an agent — one topic, one session, a visible title, one card per turn.**

> Scope: the engine is still dsh. The agent loop, tools, sandbox and skills are unchanged; this package adds the conversation semantics and the chat surface around them.

## What you get

- **One scope, one session** — p2p, topic, and group-per-user sessions are kept separate.
- **Visible titles** — generated from the first prompt and shown on the turn card.
- **One card per turn** — status and answer live in the same card, edited in place; the final answer is not a second message.
- **14 commands** — `/new`, `/sessions`, `/rename`, `/resume`, `/adopt`, `/status`, `/stop`, `/doctor`, `/selfcheck`, `/persona`, `/whoami`, `/export`, `/permission`, `/help`.
- **Persona** — `SOUL.md` is synced into the `AGENTS.md` block, automatically at startup.
- **Observability** — two-stage self-check, `/doctor`, and in-chat degradation warnings.

## Looks like

```text
飞书会话 · 过程
会话：重构登录流程 · **运行中** · 步数 4 · 工具 3 · 已运行 12s
最近：bash
（the answer streams inside this card; at turn end the same card is frozen as 完成）
```

This is a text sketch, not a screenshot. At turn end the card shows the terminal state and the complete answer; a degraded card (preset not mounted) is marked `（preset 未挂载）`.

## Requirements

| Requirement | Version / note |
|:--|:--|
| dsh | `>=0.2.1-rc.2` |
| Node.js | `>=22.13` |
| pnpm | `>=10` (pnpm 11 tested) |
| Feishu / Lark app | One app can have **one long-connection consumer** at a time |

## Install

1. Add the package (the build flag is required, see the note below):

   ```bash
   dsh plugin --profile web add dsh-caduceus --allow-build=protobufjs
   ```

2. In the profile's `cordis.patch.yml`, give the `caduceus-gateway` row your Feishu credentials
   (`appId` / `appSecret`, or `FEISHU_APP_ID` / `FEISHU_APP_SECRET`).

3. Restart dsh from the host side. The log should contain `feishu long connection started`.

> **pnpm ≥10 note**: `protobufjs` is a transitive dependency of the Feishu SDK, and pnpm ≥10 does not
> run dependency install/build scripts by default. Use `--allow-build=protobufjs` **with the equals
> sign**; the space form (`--allow-build protobufjs`) fails with
> `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`. Without the flag the install fails with
> `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: protobufjs@7.6.6`.
> Alternatively, pre-authorize in the profile's `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - protobufjs
```

> Confirm the install with `dsh --profile web --dump-config | grep dsh-caduceus` — expect at least 2 lines.

## Configure

| Key | Default | Description |
|:--|:--|:--|
| `appId` / `appSecret` | — | Feishu app credentials; `FEISHU_APP_ID` / `FEISHU_APP_SECRET` also work |
| `defaultCwd` | process cwd | Working directory for new sessions |
| `groupSessionsPerUser` | `true` | Isolate ordinary groups per sender; topics are unaffected |
| `busyMode` | `queue` | Busy delivery: `queue` / `steer` / `interrupt` |
| `cardThrottleMs` | `400` | Process-card patch throttle (ms) |
| `personaAutoSync` | `true` | Sync SOUL into `$DSH_HOME/AGENTS.md` at startup |
| `agentPreset` | `standard` | dsh agent preset mounted for new sessions |
| `logLevel` | `info` | File log level: `info` / `debug` |
| `approvalCard` | `true` | Send interactive approval cards (`allow once` / `reject`) |
| `questionCard` | `true` | Send interactive question cards; single-select ≤4 options get buttons |
| `interactiveTimeoutMs` | `300000` | How long an approval/question card waits before it expires |
| `approvalPolicy` | unset | Optional override: `ask` / `never`; unset leaves dsh approval policy untouched |
| `reactions` | `true` | Emoji reactions on messages: `OnIt` while running, `DONE`/`CROSS_MARK` at turn end |
| `reactionOnStart` | `OnIt` | Reaction added when a user message is accepted |
| `reactionOnDone` | `DONE` | Reaction added when a turn completes |
| `reactionOnFail` | `CROSS_MARK` | Reaction added when a turn errors/interrupts (falls back to `THINKING`) |
| `gateRequireBotIdentity` | `true` | Group @ gate fails closed when the bot open id is unknown |
| `images` | `true` | Accept image messages and attach them to the agent prompt |
| `files` | `true` | Accept file messages (durable attachment or saved to cwd) |
| `maxAttachmentBytes` | `20971520` | Per-attachment download limit (20 MiB) |
| `sendMedia` | `true` | Send `MEDIA:/path` outputs from the agent back to Feishu |
| `maxSendFileBytes` | `31457280` | Outbound file limit (30 MiB) |
| `maxSendImageBytes` | `10485760` | Outbound image limit (10 MiB) |
| `mediaRoots` | `[]` | Allowed roots for outbound paths (empty = session cwd) |
| `admins` | `[]` | Admin open-id allowlist; empty disables access control |
| `lang` | `zh` | Permission UI language: `zh` (default), `en`, or `auto` (settings/env, then zh) |

## Commands

| Command | Description |
|:--|:--|
| `/new` | Materialize a new session immediately; keep the old one |
| `/sessions [--all]` | List the current session, or every session of this chat |
| `/rename <title>` | Rename the current session |
| `/resume [id\|tail]` | Resume the previous session, or switch by full id / ≥8-char tail |
| `/adopt <id\|tail>` | Adopt an unowned historical session into the current scope |
| `/status` | Current session status plus the self-check summary |
| `/stop` | Interrupt the running turn |
| `/doctor [--json]` | Health report: runtime / Feishu / persona / session / storage / versions |
| `/selfcheck` | Re-run both self-check stages and print every item |
| `/persona [show\|sync]` | Show or sync the SOUL persona block |
| `/whoami` | Show your open_id, current chat/topic, and admin/guest role |
| `/export [--json]` | Export the current session as markdown or raw JSONL and send it as a file |
| `/permission [preset]` | Permission card: current preset, usage line, and one switch button per preset; labels and copy follow the dsh locale |
| `/help` | Command table |

## Troubleshooting

- **No `feishu long connection started` in the log**: run `/doctor` first, then check the file log at `$DSH_HOME/caduceus/caduceus.log`.
- **`/doctor`**: shows runtime, Feishu, persona, session and storage checks; `/doctor --json` gives the same report for scripts or support.
- **In-chat warnings**: self-check failures are posted into the conversation as `⚠ 自检异常 …（详情 /doctor）`; recovery posts `✓ 自检已恢复`.
- **`preset:applied` fails**: the agent was created without a preset, so it has no tools and no persona. Check `agentPreset` and that the `agentPresets` service is available.
- **`persona:fresh` fails**: `SOUL.md` and the block in `$DSH_HOME/AGENTS.md` differ. Run `/persona sync` or let the next startup auto-sync.
- **Install failed with `ERR_PNPM_IGNORED_BUILDS` / `ERR_PNPM_ALLOW_BUILD_MISSING_PACKAGE`**: see the pnpm note under Install.

## Limitations

- One Feishu/Lark app supports one long-connection consumer; do not run the same app in two dsh instances.
- Command turns (`/doctor`, `/status`, `/sessions`, …) do not go through the agent, so tool counts may read `pending` until a normal message is sent.
- The persona projection targets `$DSH_HOME/AGENTS.md`; a legacy block in `$DSH_AGENTS_HOME/AGENTS.md` is only reported and never deleted.
- The file log rotates at 5 MB and keeps 3 files.
- There is no separate Web UI install wizard; installation is through the dsh CLI.

## Docs

- [docs/DESIGN.md](docs/DESIGN.md) — design and surface semantics
- [docs/VERIFY.md](docs/VERIFY.md) — isolated-profile verification steps
- [docs/](docs/) — slice notes (`SLICE*.md`)

## License

[MIT](LICENSE) © 2026 ArtomYuan
