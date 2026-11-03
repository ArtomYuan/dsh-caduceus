/** Client-side copy for the header button, drawer, and settings row. */
export const NS = 'caduceus';

export const ZH = {
  'switch.panel': '双蛇杖',
  'panel.title': '双蛇杖工作台',
  'panel.loaded': '面板已加载',
  'panel.version': '版本',
  'drawer.session': '会话',
  'drawer.none': '无会话',
  'drawer.close': '关闭',
  'settings.title': '双蛇杖',
  'settings.lang': '语言',
  'settings.metrics': '指标',
  'settings.busyMode': '忙碌策略',
  'settings.unavailable': '客户端配置尚未注入',
} as const;

export const EN = {
  'switch.panel': 'Caduceus',
  'panel.title': 'Caduceus Workbench',
  'panel.loaded': 'Panel loaded',
  'panel.version': 'Version',
  'drawer.session': 'Session',
  'drawer.none': 'no session',
  'drawer.close': 'Close',
  'settings.title': 'Caduceus',
  'settings.lang': 'Language',
  'settings.metrics': 'Metrics',
  'settings.busyMode': 'Busy mode',
  'settings.unavailable': 'Client config not injected yet',
} as const;

export type LabelKey = keyof typeof ZH;
export const FALLBACK: Record<LabelKey, string> = ZH;
