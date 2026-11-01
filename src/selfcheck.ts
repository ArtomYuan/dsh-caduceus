/**
 * Startup and per-session self-check.
 *
 * Three same-shaped incidents (sessionTitle, agentPresets, status card) were
 * silent degradations: one warn line, then weeks of a broken surface. This
 * module turns those degradations into visible `ok | fail | skip` items.
 *
 * Stage A (after plugin ready, non-blocking):
 *   preset:service / instructions:block / persona:fresh / tools:service
 * Stage B (after each successful create/resume):
 *   preset:applied / tools:count
 *
 * Rules:
 * - `skip` is used when an API is genuinely unavailable; never report a fake
 *   `fail` for it.
 * - exceptions become `skip` (with the reason), they never throw to startup.
 * - logs: one `selfcheck: ok ...` line when everything is ok, or one
 *   `selfcheck: FAIL <items>` line when anything fails. Re-checks only log when
 *   the fail set / status changes.
 *
 * @module @artomyuan/dsh-caduceus/selfcheck
 */
import { readFile } from 'node:fs/promises';

import type { AgentPresetsLike } from './bridge/types.js';
import { defaultAgentsFile, defaultSoulCandidatePaths, type HomeEnv } from './home.js';
import { silentLogger, type LoggerLike } from './logger.js';
import { inspectSoulBlock } from './persona/blocks.js';

export type SelfCheckStatus = 'ok' | 'fail' | 'skip';

export interface SelfCheckItem {
  readonly id: string;
  readonly status: SelfCheckStatus;
  readonly detail: string;
  /** Human consequence shown in the one-line FAIL summary. */
  readonly consequence?: string;
}

export type SelfCheckOutcome = 'ok' | 'degraded' | 'fail';

export interface SelfCheckReport {
  readonly stage: 'A' | 'B';
  readonly items: readonly SelfCheckItem[];
  /** fail if any item failed; degraded if only skips; ok when everything ran ok. */
  readonly status: SelfCheckOutcome;
}

function reportOf(stage: 'A' | 'B', items: readonly SelfCheckItem[]): SelfCheckReport {
  if (items.some((entry) => entry.status === 'fail')) return { stage, items, status: 'fail' };
  if (items.some((entry) => entry.status === 'skip')) return { stage, items, status: 'degraded' };
  return { stage, items, status: 'ok' };
}

export interface SelfCheckOptions {
  readonly env?: HomeEnv;
  readonly logger?: LoggerLike;
  /** `ctx.get('agentPresets')` (lazy, may be undefined early). */
  readonly getAgentPresets?: () => AgentPresetsLike | undefined;
  /** `ctx.get('tools')` (lazy). */
  readonly getTools?: () => unknown;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Normalize a SOUL body exactly like the sync path does. */
export function normalizeSoulBody(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

function item(
  id: string,
  status: SelfCheckStatus,
  detail: string,
  consequence?: string,
): SelfCheckItem {
  return { id, status, detail, ...(consequence === undefined ? {} : { consequence }) };
}

/** The combined latest report (stage A then stage B). */
export function combineReports(
  a: SelfCheckReport | undefined,
  b: SelfCheckReport | undefined,
): readonly SelfCheckItem[] {
  return [...(a?.items ?? []), ...(b?.items ?? [])];
}

/** Format the one-line FAIL summary. */
export function failLine(items: readonly SelfCheckItem[]): string {
  const failed = items.filter((entry) => entry.status === 'fail');
  return `selfcheck: FAIL ${failed
    .map((entry) => `${entry.id}(fail): ${entry.consequence ?? entry.detail}`)
    .join(', ')}`;
}

/** Format the one-line OK summary. */
export function okLine(preset: string, tools: number, personaBytes: number): string {
  return `selfcheck: ok preset=${preset} tools=${tools} persona=${personaBytes}B`;
}

/** Format one detail line for `/selfcheck`. */
export function detailLine(entry: SelfCheckItem): string {
  return `${entry.id}: ${entry.status} — ${entry.detail}`;
}

/** Run both stages, keep the latest state, and emit de-duplicated log lines. */
export class SelfChecker {
  readonly #options: SelfCheckOptions;
  #stageA: SelfCheckReport | undefined;
  #stageB: SelfCheckReport | undefined;
  #personaBytes = 0;
  #lastLogged: string | undefined;
  #lastAgentCtx: unknown;
  #lastSession: unknown;
  #hasLastSession = false;
  #lastToolCount: number | undefined;

  constructor(options: SelfCheckOptions = {}) {
    this.#options = options;
  }

  /** Stage A: services + instruction block + persona freshness. */
  async runStageA(): Promise<SelfCheckReport> {
    const items: SelfCheckItem[] = [];
    items.push(this.#checkPresetService());
    const block = await this.#checkInstructionsBlock();
    items.push(block.blockItem);
    items.push(await this.#checkPersonaFresh(block));
    items.push(this.#checkToolsService());
    const report = reportOf('A', items);
    this.#stageA = report;
    this.#maybeLog();
    return report;
  }

  /** Stage B: applied preset + tool count for one created/resumed agent. */
  async runStageB(agentCtx?: unknown): Promise<SelfCheckReport> {
    if (agentCtx !== undefined) this.#lastAgentCtx = agentCtx;
    // tools:count is deliberately deferred to the session's first step/start:
    // create() returns before the async preset mount has registered every tool.
    const items: SelfCheckItem[] = [
      this.#checkPresetApplied(),
      item('tools:count', 'skip', 'pending：等待首条 request/header（模型实际工具清单）'),
    ];
    // First-touch validation: if a service was skipped during startup, refresh
    // its stage-A item now that a real create/resume succeeded.
    if (this.#stageA !== undefined) {
      const refreshed = this.#stageA.items.map((entry) => {
        if (entry.id === 'preset:service' && entry.status === 'skip') return this.#checkPresetService();
        if (entry.id === 'tools:service' && entry.status === 'skip') return this.#checkToolsService();
        return entry;
      });
      this.#stageA = reportOf('A', refreshed);
    }
    const report = reportOf('B', items);
    this.#stageB = report;
    this.#maybeLog();
    return report;
  }

  /** `/selfcheck`: rerun both stages (stage B only if an agent context exists). */
  async runAll(): Promise<SelfCheckReport> {
    await this.runStageA();
    await this.runStageB(this.#lastAgentCtx);
    if (this.#lastToolCount !== undefined) {
      await this.checkTools(this.#lastToolCount);
    }
    const items = combineReports(this.#stageA, this.#stageB);
    return reportOf('B', items);
  }

  /**
   * Decide `tools:count` from the session's FIRST `request/header` event.
   * The header's `tools` array is exactly what the model receives — the only
   * authoritative source. No tools-service counting, no second source.
   */
  async checkTools(toolCount: number): Promise<SelfCheckReport> {
    this.#lastToolCount = toolCount;
    const toolsItem: SelfCheckItem =
      toolCount === 0
        ? item('tools:count', 'fail', 'request/header.tools 为空', 'request/header.tools 为空')
        : item('tools:count', 'ok', `tools=${toolCount}`);
    const baseItems = this.#stageB?.items ?? [
      this.#checkPresetApplied(),
      item('tools:count', 'skip', 'pending：等待首条 request/header'),
    ];
    const items = baseItems.map((entry) => (entry.id === 'tools:count' ? toolsItem : entry));
    const report = reportOf('B', items);
    this.#stageB = report;
    this.#maybeLog();
    return report;
  }

  /** Combined report for display. */
  report(): readonly SelfCheckItem[] {
    return combineReports(this.#stageA, this.#stageB);
  }

  /** `/status` first line. */
  statusLine(): string {
    const items = this.report();
    const failed = items.filter((entry) => entry.status === 'fail').map((entry) => entry.id);
    if (failed.length > 0) return `自检 ✗ ${failed.join(', ')}`;
    const b = this.#stageB;
    const a = this.#stageA;
    // Stage B is the authoritative runtime validation; A's service skips are
    // downgraded to skip precisely so they never mask a real session check.
    if (b !== undefined && b.status === 'ok' && (a === undefined || a.status !== 'fail')) {
      return '自检 ✓';
    }
    if (a !== undefined && a.status === 'degraded' && b === undefined) {
      return '自检 ○（待首会话验证）';
    }
    if (items.some((entry) => entry.status === 'skip')) return '自检 ○（待首会话验证）';
    return '自检 …';
  }

  /** `/selfcheck` full detail, one line per item. */
  detailText(): string {
    const items = this.report();
    if (items.length === 0) return '自检尚未运行。';
    return items.map(detailLine).join('\n');
  }

  #checkPresetService(): SelfCheckItem {
    try {
      const service = this.#options.getAgentPresets?.();
      if (service === undefined) {
        return item(
          'preset:service',
          'skip',
          '尚未注册（惰性解析，首次建会话时判定）',
        );
      }
      return item('preset:service', 'ok', '服务可用');
    } catch (error) {
      return item('preset:service', 'skip', `检查失败：${errorMessage(error)}`);
    }
  }

  async #checkInstructionsBlock(): Promise<{
    blockItem: SelfCheckItem;
    content?: string;
  }> {
    const target = defaultAgentsFile(this.#options.env);
    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        return { blockItem: item('instructions:block', 'fail', `AGENTS.md 不存在（${target}）`) };
      }
      return { blockItem: item('instructions:block', 'skip', `读取失败：${errorMessage(error)}`) };
    }
    const inspection = inspectSoulBlock(text);
    if (inspection.status === 'absent') {
      return { blockItem: item('instructions:block', 'fail', `没有人格块标记（${target}）`) };
    }
    if (inspection.status === 'malformed') {
      return { blockItem: item('instructions:block', 'fail', `人格块损坏：${inspection.reason}`) };
    }
    const bytes = Buffer.byteLength(inspection.content.trim(), 'utf8');
    return {
      blockItem: item('instructions:block', 'ok', `人格块存在（${bytes}B，${target}）`),
      content: inspection.content,
    };
  }

  async #checkPersonaFresh(block: {
    blockItem: SelfCheckItem;
    content?: string;
  }): Promise<SelfCheckItem> {
    if (block.blockItem.status !== 'ok' || block.content === undefined) {
      return item('persona:fresh', 'skip', '指令块不可用');
    }
    for (const candidate of defaultSoulCandidatePaths(this.#options.env)) {
      try {
        const soul = normalizeSoulBody(await readFile(candidate, 'utf8'));
        this.#personaBytes = Buffer.byteLength(soul, 'utf8');
        if (block.content.trim() === soul) {
          return item('persona:fresh', 'ok', `与 ${candidate} 一致（${this.#personaBytes}B）`);
        }
        return item(
          'persona:fresh',
          'fail',
          `与 ${candidate} 不一致，发 /persona sync 或等待自动同步`,
          '人格块未同步到 AGENTS.md',
        );
      } catch (error) {
        if (isNotFound(error)) continue;
        return item('persona:fresh', 'skip', `SOUL 读取失败：${errorMessage(error)}`);
      }
    }
    return item('persona:fresh', 'skip', 'SOUL 源缺失');
  }

  #checkToolsService(): SelfCheckItem {
    try {
      const service = this.#options.getTools?.();
      if (service === undefined) {
        return item(
          'tools:service',
          'skip',
          '尚未注册（惰性解析，首次建会话时判定）',
        );
      }
      return item('tools:service', 'ok', '服务可用');
    } catch (error) {
      return item('tools:service', 'skip', `检查失败：${errorMessage(error)}`);
    }
  }

  #checkPresetApplied(): SelfCheckItem {
    const presets = this.#options.getAgentPresets?.();
    if (presets === undefined) return item('preset:applied', 'skip', 'agentPresets 服务未就绪');
    try {
      const preset = presets.composedPreset(this.#lastAgentCtx);
      if (preset === undefined || preset.length === 0) {
        return item(
          'preset:applied',
          'fail',
          'agent 未挂载 preset',
          'agent 无工具无人格',
        );
      }
      return item('preset:applied', 'ok', `preset=${preset}`);
    } catch (error) {
      return item('preset:applied', 'skip', `检查失败：${errorMessage(error)}`);
    }
  }

  #maybeLog(): void {
    const logger = this.#options.logger ?? silentLogger();
    const items = this.report();
    const failed = items.filter((entry) => entry.status === 'fail');
    if (failed.length > 0) {
      const key = `FAIL:${failed.map((entry) => entry.id).join(',')}`;
      if (key === this.#lastLogged) return;
      this.#lastLogged = key;
      logger.warn(failLine(items));
      return;
    }
    if (this.#stageA !== undefined && this.#stageA.status === 'degraded' && this.#stageB === undefined) {
      const skipped = this.#stageA.items
        .filter((entry) => entry.status === 'skip')
        .map((entry) => entry.id);
      const key = `deferred:${skipped.join(',')}`;
      if (key === this.#lastLogged) return;
      this.#lastLogged = key;
      logger.info(
        `selfcheck: ok (skipped: ${skipped.join(', ')}; deferred to first session)`,
      );
      return;
    }
    if (this.#stageA === undefined || this.#stageB === undefined) return;
    if (!items.every((entry) => entry.status === 'ok')) return;
    const presetItem = items.find((entry) => entry.id === 'preset:applied');
    const toolsItem = items.find((entry) => entry.id === 'tools:count');
    const preset = presetItem?.detail.replace(/^preset=/, '') ?? 'unknown';
    const tools = Number(toolsItem?.detail.replace(/^tools=/, '') ?? 0);
    const key = `ok:${preset}:${tools}:${this.#personaBytes}`;
    if (key === this.#lastLogged) return;
    this.#lastLogged = key;
    logger.info(okLine(preset, tools, this.#personaBytes));
  }
}
