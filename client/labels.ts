/** Client-side copy for the workbench switch/panel. */
export const NS = 'caduceus';

export const ZH = {
  'switch.conversation': '对话',
  'switch.panel': '双蛇杖',
  'panel.title': '双蛇杖工作台',
  'panel.loaded': '面板已加载',
  'panel.version': '版本',
} as const;

export const EN = {
  'switch.conversation': 'Conversation',
  'switch.panel': 'Caduceus',
  'panel.title': 'Caduceus Workbench',
  'panel.loaded': 'Panel loaded',
  'panel.version': 'Version',
} as const;

export type LabelKey = keyof typeof ZH;
export const FALLBACK: Record<LabelKey, string> = ZH;
