/**
 * Surface i18n for the permission UI.
 *
 * Language order:
 * 1. explicit plugin config `lang: zh|en` (never consults settings/env);
 * 2. `lang: auto` -> host `locale.preference`;
 * 3. `lang: auto` -> LC_ALL/LANG, accepted only when the value starts with
 *    `zh` or `en` (C/C.UTF-8/POSIX/empty are ignored);
 * 4. zh.
 *
 * Settings access is best-effort and never cached: a missing service must not
 * break or stick on a failure.
 *
 * @module dsh-caduceus/i18n
 */
export type Lang = 'zh' | 'en';
export type LangSetting = Lang | 'auto';

export interface PermissionLineData {
  readonly name: string;
  readonly sandbox?: string;
  readonly approval?: string;
}

export interface Dict {
  permissionTitle(currentLabel: string): string;
  customLabel: string;
  usage: string;
  approvalLine(label: string, approval: string): string;
  approvalLabel(value: string): string;
  switchSucceeded(label: string, hint: string): string;
  unknownPreset(name: string, available: string): string;
  switchedElsewhere(text: string): string;
}

/** Official dsh preset labels (client ui-permission-presets locales). */
const ZH_LABELS: Readonly<Record<string, string>> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: '自动审查（EXP）',
};

const EN_LABELS: Readonly<Record<string, string>> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full access',
  auto: 'Auto review (EXP)',
};

/** Official display label for one preset; unknown presets keep their raw name. */
export function presetLabel(lang: Lang, name: string): string {
  const labels = lang === 'en' ? EN_LABELS : ZH_LABELS;
  return labels[name] ?? name;
}

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

const ZH: Dict = {
  permissionTitle: (label) => '权限 · 当前：' + label,
  customLabel: '自定义（不匹配任何预设）',
  usage: '用法：/permission <档位>，或点下方按钮',
  approvalLine: (label, approval) => '档位 ' + label + ' · 审批 ' + approval,
  approvalLabel: approvalLabelZh,
  switchSucceeded: (label, hint) => '已切换到 ' + label + '（' + hint + '）',
  unknownPreset: (name, available) => '未知档位 ' + name + '，可用：' + available,
  switchedElsewhere: (text) => '已执行 /permission（dsh 原文：' + text + '）',
};


const EN: Dict = {
  permissionTitle: (label) => 'Permission · current: ' + label,
  customLabel: 'Custom (matches no preset)',
  usage: 'Usage: /permission <preset>, or tap a button below',
  approvalLine: (label, approval) => 'preset ' + label + ' · approval ' + approval,
  approvalLabel: approvalLabelEn,
  switchSucceeded: (label, hint) => 'Switched to ' + label + ' (' + hint + ')',
  unknownPreset: (name, available) => 'Unknown preset ' + name + '; available: ' + available,
  switchedElsewhere: (text) => 'Ran /permission (dsh output: ' + text + ')',
};


export function t(lang: Lang): Dict {
  return lang === 'en' ? EN : ZH;
}

/**
 * Resolve the effective language.
 *
 * Overload note: `resolveLang(provider)` is treated as `lang: auto` with that
 * settings provider (kept for the original call sites).
 */
export function resolveLang(
  langOrProvider?: LangSetting | (() => unknown),
  maybeProvider?: () => unknown,
): Lang {
  const configured: LangSetting =
    typeof langOrProvider === 'function' ? 'auto' : (langOrProvider ?? 'auto');
  const provider = typeof langOrProvider === 'function' ? langOrProvider : maybeProvider;

  // Explicit configuration always wins over settings and environment.
  if (configured === 'zh' || configured === 'en') return configured;

  try {
    const settings = provider?.();
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
      const value = typeof record?.get === 'function' ? record.get() : record;
      const preference = (value as { preference?: unknown } | undefined)?.preference;
      if (preference === 'zh' || preference === 'en') return preference;
    }
  } catch {
    // Missing/partial settings service: fall through to environment.
  }

  const locale = (process.env['LC_ALL'] ?? process.env['LANG'] ?? '').trim().toLowerCase();
  if (locale.startsWith('zh')) return 'zh';
  if (locale.startsWith('en')) return 'en';
  return 'zh';
}
