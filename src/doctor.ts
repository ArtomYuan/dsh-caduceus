/**
 * `/doctor` — a human-readable health report (plain text, not a card).
 *
 * Every check is wrapped independently: a throwing check becomes one `✗` line
 * with the error summary and never fails the whole report. Missing data is `○`
 * with a reason. Secrets are never printed (appSecret is not part of the model
 * at all; the appId is masked).
 *
 * @module @artomyuan/dsh-caduceus/doctor
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { dshHome, defaultAgentsFile, defaultSoulCandidatePaths, legacyAgentsFile, userHome, type HomeEnv } from './home.js';
import { inspectSoulBlock } from './persona/blocks.js';
import { normalizeSoulBody } from './selfcheck.js';

export type DoctorMark = 'ok' | 'fail' | 'skip' | 'warn';

export interface DoctorItem {
  readonly id: string;
  readonly name: string;
  readonly mark: DoctorMark;
  readonly detail: string;
}

export interface DoctorSection {
  readonly title: string;
  readonly items: readonly DoctorItem[];
}

export interface DoctorSessionInfo {
  readonly scopeKey: string;
  readonly sessionId?: string;
  readonly preset?: string;
  readonly presetMounted?: boolean;
  readonly toolsCount?: number;
  readonly historyLength?: number;
}

export interface DoctorInputs {
  readonly versions: { readonly plugin: string; readonly dsh: string; readonly node: string };
  readonly runtime: {
    readonly preset?: string;
    readonly presetMounted?: boolean;
    readonly toolsCount?: number;
    readonly sessionTitleService?: boolean;
    readonly agentsService?: boolean;
  };
  readonly feishu: {
    readonly appId?: string;
    readonly botName?: string;
    readonly connectionReady?: boolean;
    readonly connectedSince?: number;
    readonly lastSendAt?: number;
    readonly lastSendKind?: string;
    readonly sendFailures?: number;
  };
  readonly persona: { readonly env?: HomeEnv };
  readonly session: DoctorSessionInfo;
  readonly storage: {
    readonly mapVersion?: number;
    readonly mapWritable?: boolean;
    readonly mapEntries?: number;
  };
  readonly now?: number;
}

export interface DoctorReport {
  readonly title: string;
  readonly sections: readonly DoctorSection[];
  readonly counts: {
    readonly normal: number;
    readonly fail: number;
    readonly skip: number;
    readonly warn: number;
  };
  readonly items: readonly DoctorItem[];
}

const MARK_TEXT: Record<DoctorMark, string> = { ok: '✓', fail: '✗', skip: '○', warn: '!' };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskAppId(appId: string): string {
  if (appId.length <= 8) return appId;
  return `${appId.slice(0, 7)}…${appId.slice(-4)}`;
}

function displayPath(path: string, env?: HomeEnv): string {
  const home = userHome(env);
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function displayScopeKey(key: string): string {
  return key.replace(/\u0000/g, '\\0');
}

function relativeAge(ms: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

function duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
}

async function safeItem(
  section: string,
  id: string,
  name: string,
  read: () => Promise<{ mark: DoctorMark; detail: string }> | { mark: DoctorMark; detail: string },
): Promise<DoctorItem> {
  try {
    const result = await read();
    return { id, name, mark: result.mark, detail: result.detail };
  } catch (error) {
    return { id, name, mark: 'fail', detail: `检查失败：${errorMessage(error)}` };
  }
}

/** Build the report. Individual checks never throw; the whole report never throws. */
export async function buildDoctorReport(inputs: DoctorInputs): Promise<DoctorReport> {
  const now = inputs.now ?? Date.now();
  const env = inputs.persona.env;
  const home = dshHome(env);
  const homeDisplay = displayPath(home, env);
  const legacyDisplay = displayPath(legacyAgentsFile(env), env);
  const agentsFile = defaultAgentsFile(env);
  const agentsDisplay = displayPath(agentsFile, env);

  // ---- runtime ----
  const versions = await safeItem('runtime', 'versions', '版本', () => ({
    mark: 'ok',
    detail: `插件 ${inputs.versions.plugin} / dsh ${inputs.versions.dsh} / node ${inputs.versions.node}`,
  }));
  const preset = await safeItem('runtime', 'preset', 'preset', () => {
    const id = inputs.runtime.preset;
    if (inputs.runtime.presetMounted === true) return { mark: 'ok', detail: `${id ?? '?'}（已挂载）` };
    if (id === undefined && inputs.runtime.presetMounted === undefined) {
      return { mark: 'skip', detail: '未知（尚未 create/resume）' };
    }
    return { mark: 'fail', detail: `${id ?? '?'}（未挂载）` };
  });
  const tools = await safeItem('runtime', 'tools', '工具', () => {
    const count = inputs.runtime.toolsCount;
    if (count === undefined) return { mark: 'skip', detail: 'pending（尚未收到首条 request/header）' };
    if (count === 0) return { mark: 'fail', detail: '0 个（request/header.tools 为空）' };
    return { mark: 'ok', detail: `${count} 个（来自首条请求）` };
  });
  const sessionTools = await safeItem('runtime', 'session-tools', '当前会话工具数', () => {
    const count = inputs.runtime.toolsCount;
    if (count === undefined) return { mark: 'skip', detail: 'pending（本会话尚未发起请求）' };
    return { mark: 'ok', detail: `${count} 个` };
  });
  const titleService = await safeItem('runtime', 'session-title', '标题服务', () => {
    if (inputs.runtime.sessionTitleService === undefined) return { mark: 'skip', detail: '不可用' };
    return inputs.runtime.sessionTitleService
      ? { mark: 'ok', detail: '可用' }
      : { mark: 'fail', detail: '不可用' };
  });
  const agentsService = await safeItem('runtime', 'agents', 'agents 服务', () => {
    if (inputs.runtime.agentsService === undefined) return { mark: 'skip', detail: '不可用' };
    return inputs.runtime.agentsService
      ? { mark: 'ok', detail: '可用' }
      : { mark: 'fail', detail: '不可用' };
  });

  // ---- feishu ----
  const credentials = await safeItem('feishu', 'credentials', '凭证', () => {
    const appId = inputs.feishu.appId;
    if (appId === undefined || appId.length === 0) return { mark: 'fail', detail: '未配置 appId' };
    const bot = inputs.feishu.botName === undefined ? '' : `（机器人：${inputs.feishu.botName}）`;
    return { mark: 'ok', detail: `${maskAppId(appId)}${bot}` };
  });
  const connection = await safeItem('feishu', 'connection', '长连接', () => {
    if (inputs.feishu.connectionReady === undefined) return { mark: 'skip', detail: '未知' };
    if (inputs.feishu.connectionReady !== true) return { mark: 'fail', detail: '未连接' };
    const since = inputs.feishu.connectedSince;
    const uptime = since === undefined ? '' : `（已运行 ${duration(now - since)}）`;
    return { mark: 'ok', detail: `ready${uptime}` };
  });
  const delivery = await safeItem('feishu', 'delivery', '卡片编辑权限', () => {
    const failures = inputs.feishu.sendFailures ?? 0;
    if (failures > 0) return { mark: 'fail', detail: `最近发送失败 ${failures} 次` };
    if (inputs.feishu.lastSendAt === undefined) return { mark: 'skip', detail: '未验证（尚无发送记录）' };
    const kind = inputs.feishu.lastSendKind ?? '消息';
    return { mark: 'ok', detail: `最近一次${kind}成功于 ${relativeAge(inputs.feishu.lastSendAt, now)}` };
  });

  // ---- persona ----
  const soulCandidates = defaultSoulCandidatePaths(env);
  let soulPath: string | undefined;
  let soulBody: string | undefined;
  for (const candidate of soulCandidates) {
    try {
      soulBody = normalizeSoulBody(await readFile(candidate, 'utf8'));
      soulPath = candidate;
      break;
    } catch {
      // try next candidate
    }
  }
  const soul = await safeItem('persona', 'soul', '源', () => {
    if (soulPath === undefined || soulBody === undefined) return { mark: 'fail', detail: 'SOUL 源缺失' };
    return {
      mark: 'ok',
      detail: `${displayPath(soulPath, env)}（${Buffer.byteLength(soulBody, 'utf8')}B）`,
    };
  });
  let agentsText: string | undefined;
  try {
    agentsText = await readFile(agentsFile, 'utf8');
  } catch {
    agentsText = undefined;
  }
  const projection = await safeItem('persona', 'projection', '投影', () => {
    if (agentsText === undefined) return { mark: 'fail', detail: `${agentsDisplay}（不存在）` };
    const inspection = inspectSoulBlock(agentsText);
    if (inspection.status === 'absent') return { mark: 'fail', detail: `${agentsDisplay}（没有人格块）` };
    if (inspection.status === 'malformed') {
      return { mark: 'fail', detail: `${agentsDisplay}（人格块损坏：${inspection.reason}）` };
    }
    if (soulBody !== undefined && inspection.content.trim() !== soulBody) {
      return { mark: 'fail', detail: `${agentsDisplay}（与源不一致，发 /persona sync）` };
    }
    return { mark: 'ok', detail: `${agentsDisplay}（块存在，与源一致）` };
  });
  const legacy = await safeItem('persona', 'legacy', '遗留块', async () => {
    const target = legacyAgentsFile(env);
    let text: string;
    try {
      text = await readFile(target, 'utf8');
    } catch {
      return { mark: 'skip', detail: '无' };
    }
    const inspection = inspectSoulBlock(text);
    if (inspection.status === 'absent') return { mark: 'skip', detail: '无' };
    return { mark: 'warn', detail: `${legacyDisplay}（可删除）` };
  });

  // ---- session ----
  const session = await safeItem('session', 'current', '本会话', () => {
    const sid = inputs.session.sessionId;
    if (sid === undefined) return { mark: 'skip', detail: '尚无会话' };
    const presetText = inputs.session.preset === undefined ? '' : `，preset=${inputs.session.preset}`;
    const history =
      inputs.session.historyLength === undefined ? '' : `，历史 ${inputs.session.historyLength}`;
    return { mark: 'ok', detail: `${sid}（${displayScopeKey(inputs.session.scopeKey)}${presetText}${history}）` };
  });
  const storage = await safeItem('session', 'storage', '存储', () => {
    const version = inputs.storage.mapVersion === undefined ? '?' : `v${inputs.storage.mapVersion}`;
    if (inputs.storage.mapWritable === undefined) {
      return { mark: 'skip', detail: `session-map ${version}（可写性未验证）` };
    }
    if (inputs.storage.mapWritable !== true) {
      return { mark: 'fail', detail: `session-map ${version}（不可写）` };
    }
    const entries = inputs.storage.mapEntries;
    return {
      mark: 'ok',
      detail: `session-map ${version} 可写${entries === undefined ? '' : `（${entries} 条）`}`,
    };
  });

  const personaItems: DoctorItem[] = [soul, projection];
  // Absent legacy blocks are not a check result; only surface them when found.
  if (legacy.mark !== 'skip') personaItems.push(legacy);
  const sections: DoctorSection[] = [
    { title: '运行时', items: [versions, preset, tools, sessionTools, titleService, agentsService] },
    { title: '飞书', items: [credentials, connection, delivery] },
    { title: '人格', items: personaItems },
    { title: '会话', items: [session, storage] },
  ];
  const items = sections.flatMap((section) => section.items);
  const counts = {
    normal: items.filter((entry) => entry.mark === 'ok' || entry.mark === 'warn').length,
    fail: items.filter((entry) => entry.mark === 'fail').length,
    skip: items.filter((entry) => entry.mark === 'skip').length,
    warn: items.filter((entry) => entry.mark === 'warn').length,
  };
  return {
    title: `大肥鱼 · 体检（插件 ${inputs.versions.plugin}，dsh ${inputs.versions.dsh}，node ${inputs.versions.node}）`,
    sections,
    counts,
    items,
  };
}

/** Human text, sectioned; one line per check. */
export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [report.title];
  for (const section of report.sections) {
    lines.push('', `【${section.title}】`);
    for (const item of section.items) {
      lines.push(` ${MARK_TEXT[item.mark]} ${item.name} · ${item.detail}`);
    }
  }
  lines.push(
    '',
    `【结论】${report.counts.normal} 项正常 · ${report.counts.fail} 项异常 · ${report.counts.skip} 项跳过`,
  );
  return lines.join('\n');
}

/** Machine-readable report (never contains secrets; appId is masked). */
export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(
    {
      title: report.title,
      counts: report.counts,
      sections: report.sections.map((section) => ({
        title: section.title,
        items: section.items.map((item) => ({
          id: item.id,
          name: item.name,
          mark: item.mark,
          detail: item.detail,
        })),
      })),
    },
    null,
    2,
  );
}

/** Section-agnostic helper for tests/other callers that need a display path. */
export { displayPath, maskAppId };
