/**
 * Permission UI rendered once as a Feishu card and once as plain text (the
 * send-failure fallback). Both consume the same data and the same i18n dict.
 *
 * @module dsh-caduceus/render/permission-card
 */
import type { FeishuCard } from '../transport/types.js';
import { presetLabel, t } from '../i18n.js';
import type { Dict, Lang } from '../i18n.js';
import { interactiveCard } from '../interactive/cards.js';

export interface PermissionPresetView {
  readonly name: string;
  readonly sandbox?: string;
  readonly approval?: string;
  /** False/absent when resolve failed: render the bare name only. */
  readonly resolved?: boolean;
}

export interface PermissionView {
  readonly lang: Lang;
  readonly current: string;
  readonly presets: readonly PermissionPresetView[];
}

export const PERMISSION_SWITCH_ACTION = 'caduceus.permission.switch';

function currentLabel(view: PermissionView, dict: Dict): string {
  return view.current === 'custom'
    ? dict.customLabel
    : presetLabel(view.lang, view.current);
}

function lines(view: PermissionView, dict: Dict): string[] {
  const result = [
    view.current === 'custom' ? dict.currentCustom : dict.currentLine(currentLabel(view, dict)),
    dict.availableHeading,
  ];
  for (const preset of view.presets) {
    result.push(
      preset.resolved === false
        ? '- ' + preset.name
        : dict.presetLine(preset, presetLabel(view.lang, preset.name)),
    );
  }
  result.push(dict.usage);
  if (view.current === 'custom') result.push(dict.backHint);
  return result;
}

export function buildPermissionCard(view: PermissionView): FeishuCard {
  const dict = t(view.lang);
  return interactiveCard(
    dict.permissionTitle(currentLabel(view, dict)),
    lines(view, dict),
    view.presets.map((preset) => ({
      label: presetLabel(view.lang, preset.name),
      value: { action: PERMISSION_SWITCH_ACTION, name: preset.name },
    })),
  );
}

export function renderPermissionText(view: PermissionView): string {
  return lines(view, t(view.lang)).join('\n');
}
