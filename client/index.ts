/**
 * Browser half of dsh-caduceus: a persistent Conversation/Caduceus switch in
 * `shell.overlay` and a minimal `main` panel keyed `caduceus`.
 *
 * The client bundle imports only `react` (module-table external); layout,
 * slots and locale arrive through the Cordis client context.
 */
import { createElement, useState } from 'react';
import { EN, FALLBACK, NS, ZH, type LabelKey } from './labels.ts';

declare const __CADUCEUS_VERSION__: string;

export const inject = ['slots', 'layout', 'locale'];

interface PanelInfo {
  readonly activePanelId: string | null;
}

interface StandardProps {
  readonly t?: (key: LabelKey) => string;
  readonly usePanelInfo?: <T>(selector: (info: PanelInfo) => T) => T;
}

interface ClientCtx {
  readonly layout: {
    selectPanel(panelId: string | null): void;
  };
  readonly locale: {
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void;
  };
  readonly slots: {
    register(
      spec: {
        name: 'shell.overlay' | 'main';
        key?: string;
        locale?: string;
      },
      component: (props: StandardProps) => unknown,
    ): () => void;
  };
  effect(callback: () => () => void, label?: string): void;
}

function tr(props: StandardProps): (key: LabelKey) => string {
  return props.t ?? ((key) => FALLBACK[key]);
}

function buttonStyle(active: boolean): Record<string, string> {
  return {
    padding: '4px 10px',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '6px',
    background: active ? '#2f6fed' : 'rgba(20,20,24,0.9)',
    color: '#fff',
    font: '12px/1.4 system-ui, sans-serif',
    cursor: 'pointer',
  };
}

/** Persistent two-way switch; reads the layout store when the standard hook exists. */
function WorkbenchSwitch(props: StandardProps & { ctx: ClientCtx }): unknown {
  const { ctx } = props;
  const [localPanel, setLocalPanel] = useState<string | null>(null);
  const activePanelId =
    props.usePanelInfo === undefined
      ? localPanel
      : props.usePanelInfo((info) => info.activePanelId);
  const t = tr(props);
  const select = (panelId: string | null): void => {
    setLocalPanel(panelId);
    ctx.layout.selectPanel(panelId);
  };
  return createElement(
    'div',
    {
      style: {
        position: 'fixed',
        left: '50%',
        bottom: '16px',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        gap: '6px',
        padding: '4px',
        borderRadius: '8px',
        background: 'rgba(10,10,14,0.75)',
        pointerEvents: 'auto',
      },
    },
    createElement(
      'button',
      {
        type: 'button',
        style: buttonStyle(activePanelId === null),
        onClick: () => select(null),
      },
      `[ ${t('switch.conversation')} | ${t('switch.panel')} ]`,
    ),
    createElement(
      'button',
      {
        type: 'button',
        style: buttonStyle(activePanelId === 'caduceus'),
        onClick: () => select('caduceus'),
      },
      t('switch.panel'),
    ),
  );
}

/** Minimal main-slot panel: title, plugin version, loaded marker. */
function WorkbenchPanel(props: StandardProps): unknown {
  const t = tr(props);
  return createElement(
    'section',
    {
      style: {
        padding: '24px',
        color: 'inherit',
        font: '14px/1.6 system-ui, sans-serif',
      },
    },
    createElement('h1', { style: { margin: '0 0 8px', fontSize: '20px' } }, t('panel.title')),
    createElement(
      'p',
      { style: { margin: '0 0 4px', opacity: 0.7 } },
      `${t('panel.version')} ${__CADUCEUS_VERSION__}`,
    ),
    createElement('p', { style: { margin: 0 } }, t('panel.loaded')),
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: ZH, en: EN }),
    'caduceus: client dictionaries',
  );
  ctx.effect(
    () => ctx.slots.register({ name: 'main', key: 'caduceus', locale: NS }, WorkbenchPanel),
    'caduceus: main panel',
  );
  ctx.effect(
    () =>
      ctx.slots.register({ name: 'shell.overlay', locale: NS }, (props) =>
        // `usePanelInfo` is a standard root-slot prop installed by ui-layout.
        createElement(WorkbenchSwitch, { ...props, ctx }),
      ),
    'caduceus: workbench switch',
  );
}
