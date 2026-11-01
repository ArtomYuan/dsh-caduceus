# 临时 profile 验证手册

适用范围：`dsh-caduceus` 的构建/单测自检与**临时 profile** 安装冒烟。
第一刀交付了骨架与纯逻辑模块；第二刀（飞书传输 + agent 桥接 + 状态层）已完成代码与单测，**真机飞书验收（A1–A17）需要真实凭据**，清单与验证方法见 [SLICE2.md](SLICE2.md)。

> **硬约束声明：本刀没有执行安装、没有启动或重启任何服务。**
> 下面第 2、3 节是给第二刀准备的**临时 profile** 验证步骤，只在 `/tmp` 下的临时 `DSH_HOME` 里操作；
> 生产 profile `/home/artom/.dsh/profiles/web` 只做**只读复制**，任何一步都不要 `cd` 进去执行写操作。

工作目录（下称 `$PKG`）：

```bash
PKG=/home/artom/agent-workspace/dsh/worktrees/dsh-caduceus
```

## 0. 本刀已执行的自检（不碰 ~/.dsh）

本机 Node 22 的工具链都在 `/home/artom/.local/bin`（`node`、`npm`、`npx`、`pnpm`、`dsh`），但该目录**不在默认 `PATH`**，先加进去：

```bash
export PATH="/home/artom/.local/bin:$PATH"
cd "$PKG"

pnpm install   # 若沙箱环境报 SQLite store 打不开，追加 --store-dir "$PKG/.pnpm-store"
npx tsc --noEmit
pnpm test      # 等价：tsc -p tsconfig.test.json && node --test .test-dist/test/*.test.js
pnpm smoke     # 等价：node scripts/smoke.mjs
```

预期：

- `npx tsc --noEmit` 退出 0、无输出（本刀实测退出 0）；
- 单测输出 `# tests 101`、`# pass 101`、`# fail 0`（第一刀 48 例保留，第二刀新增 53 例）；
- smoke 输出 `smoke ok: scopeKey / parseCommand / truncate / SessionStore v3 / persona / transport(thread+fallback) / status / cards / bridge-final`。

## 1. 准备临时 DSH_HOME 并只读复制生产 web profile

```bash
PROD=/home/artom/.dsh/profiles/web
VERIFY_HOME="$(mktemp -d /tmp/dsh-caduceus-verify.XXXXXX)"
mkdir -p "$VERIFY_HOME/profiles"

# 复制前记录生产侧指纹，结束时要逐字节一致
sha256sum "$PROD/package.json" "$PROD/cordis.patch.yml" "$PROD/cordis.yml" \
  > "$VERIFY_HOME/prod-before.sha256"

# 只读复制（生产目录本身不写）：复制体含凭据，仅在 /tmp，结束时删除
cp -a "$PROD" "$VERIFY_HOME/profiles/caduceus-verify"
```

说明：`cp -a` 会连同 `node_modules/`（约 71 MB）一起复制，后续 `plugin add` 的 pnpm 只修改复制体。
若想更快，可改为 `cp -a` 时排除 `node_modules` 再在临时 profile 内 `pnpm install --frozen-lockfile`，但依赖网络，不如整体复制稳。

## 2. 把本包装进临时 profile（只写 `$VERIFY_HOME`）

```bash
export PATH="/home/artom/.local/bin:$PATH"   # 提供 dsh 与 pnpm
export DSH_HOME="$VERIFY_HOME"

cd "$PKG" && pnpm build     # 先产出 dist/，file: 安装才完整

dsh plugin --profile caduceus-verify add "$PKG"
```

判定：

- 命令退出码 0；
- `"$VERIFY_HOME/profiles/caduceus-verify/package.json"` 的 `dsh.profile.bundles` 里出现 `dsh-caduceus`；
- 若报 pnpm 127：`PATH` 里没有 pnpm，确认已 `export PATH="/home/artom/.local/bin:$PATH"`；
- 若报 DSH 版本不满足：确认运行时是 `0.2.1-rc.2`（`dsh -V`），本包 peer 钉的就是它。

## 3. 三条冒烟命令

三条都在临时 `DSH_HOME` 下执行，不启动长连接、不发飞书消息。

```bash
export DSH_HOME="$VERIFY_HOME"
export PATH="$VERIFY_HOME/bin:/home/artom/.local/bin:$PATH"
```

**冒烟 1：组合后的配置树里三条 insert 都在**

```bash
dsh --profile caduceus-verify --dump-config > "$VERIFY_HOME/dump.yml"
grep -nE '^- id: (caduceus-gateway|caduceus-persona|session-title-first-prompt)$' "$VERIFY_HOME/dump.yml"
grep -cE "name: 'dsh-caduceus" "$VERIFY_HOME/dump.yml"
```

预期：

- 第一条 `grep` 命中 3 行（`caduceus-gateway`、`caduceus-persona`、`session-title-first-prompt`），且位于 `# == $PKG/cordis.patch.yml` 层；
- 第二条 `grep -c` 输出 `2`（两条自有 entry 的包名）；
- 注意：dsh-base 自带一行 `- id: session-title-llm`（同名官方 provider），本包 patch 又插了一行 `session-title-first-prompt`。两行 id 不同，dump-config 能组合通过；**是否产生双 provider 竞争，留到第二刀真机验证（见第 5 节）**，本刀不改设计稿规定的三行 insert。

**冒烟 2：四个纯逻辑模块端到端（构建产物、临时目录）**

```bash
node "$PKG/scripts/smoke.mjs"
```

预期：`smoke ok: scopeKey / parseCommand / truncate / SessionStore v3 / persona / transport(thread+fallback) / status / cards / bridge-final`。

**冒烟 3：全量单测**

```bash
cd "$PKG"
./node_modules/.bin/tsc -p tsconfig.test.json
node --test "$PKG/.test-dist/test/"*.test.js
```

预期：`# tests 101`、`# pass 101`、`# fail 0`。

## 4. 收尾：先核对生产未被改动，再清掉临时目录

```bash
unset DSH_HOME
sha256sum -c "$VERIFY_HOME/prod-before.sha256"   # 必须在删除前核对
rm -rf "$VERIFY_HOME"
cd "$PKG" && git status --short
```

预期：三项 `OK`；`git status` 只有构建产物被 `.gitignore` 忽略、无未预期改动。

## 5. 需真机才能验证的项

第二刀的代码与单测已完成；以下只能对真实飞书应用验证，逐条验证方法见 [SLICE2.md](SLICE2.md)：

- 长连接建立与两个 entry 的 `ready` 日志、官方标题 provider 注册行；
- **官方标题 provider 是否被重复挂载**：dsh-base 已有一行 `- id: session-title-llm`（`@deepseek-ai/dsh-session-title-first-prompt-llm`），本包 patch 又按设计稿 §7 插入 `- id: session-title-first-prompt`。dump-config 能组合通过，但两行是否会争抢 provider 注册，需真机确认；若冲突，应改 patch 语义而不是撕毁设计稿；
- 同群两话题两条 key / 同话题同一 sessionId 的真机行为（存储层已单测）；
- 话题回复的 `thread_id`、230071/230072/230019 降级与 uuid 去重；
- 过程卡 patch 频率/终稿新消息/状态卡步数/终端主动推送/忙时三档；
- 人格块在真实 `~/.agents/AGENTS.md` 的落盘与指令预算行；
- A1–A17 全部真机判据。

本仓库不执行任何服务启停，也不在验证中安装进生产 profile。
