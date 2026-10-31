# 第一刀验证手册

适用范围：`@artomyuan/dsh-caduceus` 第一刀（骨架 + 四个纯逻辑模块 + 单测）。
真机飞书验收（设计稿 A1–A14）属于第二刀，需要长连接、扫码/凭据与真实聊天，本手册不覆盖。

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
- 单测输出 `# tests 48`、`# pass 48`、`# fail 0`；
- smoke 输出 `smoke ok: scopeKey / parseCommand / truncateCardContent / SessionStore v3 / persona sync`。

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
- `"$VERIFY_HOME/profiles/caduceus-verify/package.json"` 的 `dsh.profile.bundles` 里出现 `@artomyuan/dsh-caduceus`；
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
grep -cE "name: '@artomyuan/dsh-caduceus" "$VERIFY_HOME/dump.yml"
```

预期：

- 第一条 `grep` 命中 3 行（`caduceus-gateway`、`caduceus-persona`、`session-title-first-prompt`），且位于 `# == $PKG/cordis.patch.yml` 层；
- 第二条 `grep -c` 输出 `2`（两条自有 entry 的包名）；
- 注意：dsh-base 自带一行 `- id: session-title-llm`（同名官方 provider），本包 patch 又插了一行 `session-title-first-prompt`。两行 id 不同，dump-config 能组合通过；**是否产生双 provider 竞争，留到第二刀真机验证（见第 5 节）**，本刀不改设计稿规定的三行 insert。

**冒烟 2：四个纯逻辑模块端到端（构建产物、临时目录）**

```bash
node "$PKG/scripts/smoke.mjs"
```

预期：`smoke ok: scopeKey / parseCommand / truncateCardContent / SessionStore v3 / persona sync`。

**冒烟 3：全量单测**

```bash
cd "$PKG"
./node_modules/.bin/tsc -p tsconfig.test.json
node --test "$PKG/.test-dist/test/"*.test.js
```

预期：`# pass 48` 且 `# fail 0`（第一刀基线）。

## 4. 收尾：先核对生产未被改动，再清掉临时目录

```bash
unset DSH_HOME
sha256sum -c "$VERIFY_HOME/prod-before.sha256"   # 必须在删除前核对
rm -rf "$VERIFY_HOME"
cd "$PKG" && git status --short
```

预期：三项 `OK`；`git status` 只有构建产物被 `.gitignore` 忽略、无未预期改动。

## 5. 本刀明确未验证的项（第二刀）

- 启动日志 `caduceus ready ×2` 与标题 provider 注册行（entry 目前是空壳）；
- **官方标题 provider 是否被重复挂载**：dsh-base 已有一行 `- id: session-title-llm`（`@deepseek-ai/dsh-session-title-first-prompt-llm`），本包 patch 又按设计稿 §7 插入 `- id: session-title-first-prompt`。dump-config 能组合通过，但两行是否会争抢 provider 注册，需在第二刀真机确认；若冲突，第二刀的修法是改 patch 语义而不是撕毁设计稿；
- 同群两话题两条 key / 同话题同一 sessionId 的**真机**行为（存储层已单测）；
- 标题、`/sessions`、`/rename` 与 `sessionTitle.rename/get` 的接线；
- 飞书发送：文本编辑 ≤20 次、卡片 patch 5 QPS / 14 天 / ≤30 KB / `update_multi: true`；
- 回复降级（230071 / 230072 / 230019 → chat_id 直发）与 `uuid` 去重；
- 人格块在真实 `~/.agents/AGENTS.md` 的落盘与指令预算行（本刀只测临时文件）；
- A1–A14 全部真机判据。

以上均依赖第二刀的传输与桥接实现，本刀不做任何服务启停或凭据操作。
