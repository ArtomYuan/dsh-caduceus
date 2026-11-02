/**
 * Minimal surface i18n for the permission UI.
 *
 * Language source: host `locale.preference` through the settings service when
 * readable, then LC_ALL/LANG, then zh. Settings access is deliberately
 * best-effort and never cached: a missing service must not break or stick.
 *
 * @module dsh-caduceus/i18n
 */
export type Lang = 'zh' | 'en';

export interface PermissionLineData {
  readonly name: string;
  readonly sandbox?: string;
  readonly approval?: string;
}

export interface Dict {
  permissionTitle: string;
  currentLine(name: string): string;
  currentCustom: string;
  availableHeading: string;
  presetLine(preset: PermissionLineData): string;
  usage: string;
  backHint: string;
  approvalLine(preset: string, approval: string): string;
  approvalLabel(value: string): string;
  cardSendFailed: string;
  switchSucceeded(preset: string, hint: string): string;
  unknownPreset(name: string, available: string): string;
  switchedElsewhere(text: string): string;
}

const ZH_HINTS: Readonly<Record<string, string>> = {
  'read-only': '只读，不能写文件',
  'workspace-write': '可写会话工作区，越界需审批',
  'danger-full-access': '沙箱全开，审批 never（慎用）',
};

const EN_HINTS: Readonly<Record<string, string>> = {
  'read-only': 'read-only, no file writes',
  'workspace-write': 'write the session workspace; outside needs approval',
  'danger-full-access': 'full sandbox, approval never (use with care)',
};

function approvalLabelZh(value: string): string {
  if (value === 'ask') return '人工确认';
  if (value === 'never') return '从不';
  return value;
}

function approvalLabelEn(value: string): string {
  if (value === 'ask') return 'manual confirmation';
  if (value === 'never') return 'never';
  return value;
}

function presetLineZh(preset: PermissionLineData): string {
  const hint = ZH_HINTS[preset.name];
  const sandbox = preset.sandbox ?? '?';
  const approval = preset.approval ?? '?';
  return '- ' + preset.name + '：沙箱 ' + sandbox + ' · 审批 ' + approval + (hint === undefined ? '' : '（' + hint + '）');
}

function presetLineEn(preset: PermissionLineData): string {
  const hint = EN_HINTS[preset.name];
  const sandbox = preset.sandbox ?? '?';
  const approval = preset.approval ?? '?';
  return '- ' + preset.name + ': sandbox ' + sandbox + ' · approval ' + approval + (hint === undefined ? '' : ' (' + hint + ')');
}

const ZH: Dict = {
  permissionTitle: '权限档位',
  currentLine: (name) => '当前档位：' + name,
  currentCustom: '当前档位：custom（当前沙箱/审批组合不匹配任何预设）',
  availableHeading: '可用档位：',
  presetLine: presetLineZh,
  usage: '用法：/permission <档位>',
  backHint: '用 /permission <档位> 回到某个预设',
  approvalLine: (preset, approval) => '档位 ' + preset + ' · 审批 ' + approval,
  approvalLabel: approvalLabelZh,
  cardSendFailed: '权限卡片发送失败，以下为文本版：',
  switchSucceeded: (preset, hint) => '已切换到 ' + preset + '（' + hint + '）',
  unknownPreset: (name, available) => '未知档位 ' + name + '，可用：' + available,
  switchedElsewhere: (text) => '已执行 /permission（dsh 原文：' + text + '）',
};

const EN: Dict = {
  permissionTitle: 'Permission preset',
  currentLine: (name) => 'Current preset: ' + name,
  currentCustom: 'Current preset: custom (sandbox/approval combination matches no preset)',
  availableHeading: 'Available presets:',
  presetLine: presetLineEn,
  usage: 'Usage: /permission <preset>',
  backHint: 'Use /permission <preset> to return to a preset',
  approvalLine: (preset, approval) => 'preset ' + preset + ' · approval ' + approval,
  approvalLabel: approvalLabelEn,
  cardSendFailed: 'Permission card failed to send; text version follows:',
  switchSucceeded: (preset, hint) => 'Switched to ' + preset + ' (' + hint + ')',
  unknownPreset: (name, available) => 'Unknown preset ' + name + '; available: ' + available,
  switchedElsewhere: (text) => 'Ran /permission (dsh output: ' + text + ')',
};

export function presetHint(lang: Lang, name: string): string {
  const hints = lang === 'en' ? EN_HINTS : ZH_HINTS;
  return hints[name] ?? name;
}

export function t(lang: Lang): Dict {
  return lang === 'en' ? EN : ZH;
}

/** Best-effort host locale resolution; settings failures fall through to env. */
export function resolveLang(settingsProvider?: () => unknown): Lang {
  try {
    const settings = settingsProvider?.();
    if (settings !== undefined && settings !== null) {
      const candidate = settings as {
        get?: (ns: string) => unknown;
        describe?: () => readonly { ns?: string; value?: unknown }[];
      };
      let section: unknown;
      if (typeof candidate.get === 'function') section = candidate.get('locale');
      else if (typeof candidate.describe === 'function') {
        section = candidate.describe().find((entry) => entry.ns === 'locale')?.value;
      }
      const record = section as
        | { get?: () => unknown; preference?: unknown }
        | undefined;
      const value =
        typeof record?.get === 'function' ? record.get() : record;
      const preference = (value as { preference?: unknown } | undefined)?.preference;
      if (preference === 'zh' || preference === 'en') return preference;
    }
  } catch {
    // Missing/partial settings service: fall through to environment.
  }
  const locale = process.env['LC_ALL'] ?? process.env['LANG'] ?? '';
  if (locale.length === 0) return 'zh';
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
