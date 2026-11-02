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

function title(view: PermissionView, dict: Dict): string {
  const label =
    view.current === 'custom' ? dict.customLabel : presetLabel(view.lang, view.current);
  return dict.permissionTitle(label);
}

function buttonLabels(view: PermissionView): string[] {
  return view.presets.map((preset) => presetLabel(view.lang, preset.name));
}
export function buildPermissionCard(view: PermissionView): FeishuCard {
  const dict = t(view.lang);
  return interactiveCard(
    title(view, dict),
    [dict.usage],
    view.presets.map((preset) => ({
      label: presetLabel(view.lang, preset.name),
      disabled: preset.name === view.current,
      value: { action: PERMISSION_SWITCH_ACTION, name: preset.name },
    })),
  );
}

export function renderPermissionText(view: PermissionView): string {
  const dict = t(view.lang);
  return [title(view, dict), dict.usage, buttonLabels(view).join(' / ')].join('\n');
}
