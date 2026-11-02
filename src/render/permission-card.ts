/**
 * Permission UI rendered once as a Feishu card and once as plain text (the
 * send-failure fallback). Both consume the same data and the same i18n dict.
 *
 * @module dsh-caduceus/render/permission-card
 */
import type { FeishuCard } from '../transport/types.js';
import { t } from '../i18n.js';
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

function lines(view: PermissionView, dict: Dict): string[] {
  const result = [
    view.current === 'custom' ? dict.currentCustom : dict.currentLine(view.current),
    dict.availableHeading,
  ];
  for (const preset of view.presets) {
    result.push(preset.resolved === false ? '- ' + preset.name : dict.presetLine(preset));
  }
  result.push(dict.usage);
  if (view.current === 'custom') result.push(dict.backHint);
  return result;
}

export function buildPermissionCard(view: PermissionView): FeishuCard {
  const dict = t(view.lang);
  return interactiveCard(
    dict.permissionTitle,
    lines(view, dict),
    view.presets.map((preset) => ({
      label: preset.name,
      value: { action: PERMISSION_SWITCH_ACTION, name: preset.name },
    })),
  );
}

export function renderPermissionText(view: PermissionView): string {
  return lines(view, t(view.lang)).join('\n');
}
