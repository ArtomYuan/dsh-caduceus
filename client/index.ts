/**
 * Browser half of dsh-caduceus: a Workbench page plus additive contributions.
 *
 * - `main` is a keyed slot. `conversation` is only one key; this module adds the
 *   `caduceus` key and takes over the centre column, so the workbench is a peer
 *   of the conversation rather than an overlay.
 * - `sidebar.panellist` is the left rail: registering an entry whose `id`
 *   equals the `main` key is what makes the page reachable by clicking, the same
 *   way the built-in panels are (no hand-drawn sidebar).
 * - A session-header action and a General-settings row remain for discoverability.
 *
 * Data comes from the host half's same-origin route (`/caduceus/state`) — never
 * from a port, a loopback URL or a CORS exception, so the same bundle works on
 * the Web build and the Desktop build (which serves the client over
 * `dsh-app://` and exposes no HTTP server).
 *
 * Every contribution goes through `ctx.slots.inject(name, …)`: boot order is not
 * ours, and a bare `register` into a not-yet-declared slot throws
 * `slot "<name>" is not declared`.
 */
import { createElement, useEffect, useState } from 'react';
import { EN, FALLBACK, NS, ZH, type LabelKey } from './labels.ts';

declare const __CADUCEUS_VERSION__: string;

export const inject = ['slots', 'locale', 'layout'];

interface StandardProps {
  readonly t?: (key: LabelKey) => string;
  readonly sessionId?: string;
}

interface ClientConfig {
  readonly lang?: string;
  readonly metrics?: string;
  readonly busyMode?: string;
}

interface ClientCtx {
  readonly layout: {
    /** Select a global main panel, or null to return to the conversation. */
    selectPanel(panelId: string | null): void;
  };
  readonly locale: {
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void;
    bind(namespace: string): (key: string) => string;
  };
  readonly slots: {
    register(
      spec: {
        name:
          | 'main'
          | 'conversation.session.header.actions'
          | 'sidebar.panellist'
          | 'settings.general.item';
        key?: string;
        id?: string;
        order?: number;
        locale?: string;
        label?: () => string;
      },
      component: (props: StandardProps) => unknown,
    ): () => void;
    /** Wait for another entry's declaration, then contribute (facade: {inject, register}). */
    inject(name: string, contribute: () => () => void): () => void;
  };
  effect(callback: () => () => void, label?: string): void;
}

/** Panel key and sidebar id must match: the rail selects this `main` key. */
const PANEL_KEY = 'caduceus';
const ROUTE = '/caduceus/state';

interface PolicyView {
  readonly transcript?: string;
  readonly collapseTiming?: string;
  readonly foldedReplies?: string;
  readonly developerTools?: boolean;
  readonly performance?: string;
}

interface SessionRow {
  readonly sessionId: string;
  readonly messages?: number;
  readonly rounds?: number;
  readonly steps?: number;
  readonly totalTokens?: number;
  readonly tokensPerSecond?: number;
}

interface StateView {
  readonly version?: string;
  readonly policy?: PolicyView;
  readonly sessions?: readonly SessionRow[];
}

function tr(props: StandardProps): (key: LabelKey) => string {
  return props.t ?? ((key) => FALLBACK[key]);
}

function globalConfig(): ClientConfig | undefined {
  return (globalThis as { __CADUCEUS_CLIENT_CONFIG__?: ClientConfig })
    .__CADUCEUS_CLIENT_CONFIG__;
}

const buttonStyle = {
  padding: '4px 10px',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: '6px',
  background: 'transparent',
  color: 'inherit',
  font: '12px/1.4 system-ui, sans-serif',
  cursor: 'pointer',
} as const;

const blockStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '12px 14px',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '10px',
} as const;

const chipStyle = {
  font: '11px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
  opacity: 0.8,
} as const;

/** Locale keys for the enumerated values, so nothing is hard-coded per language. */
function valueLabel(t: (key: LabelKey) => string, value: string | undefined): string {
  const map: Record<string, LabelKey> = {
    compact: 'wb.on',
    standard: 'wb.on',
    detailed: 'wb.on',
    verbose: 'wb.on',
    completion: 'wb.on',
    'next-input': 'wb.on',
    all: 'wb.on',
    final: 'wb.on',
  };
  if (value === undefined || value.length === 0) return '—';
  // Value names are data, not copy: render them verbatim, keeping the switch
  // labels (wb.on/wb.off) for the boolean row only.
  void map;
  void t;
  return value;
}

function Row(label: string, value: string): unknown {
  return createElement(
    'div',
    { style: { display: 'flex', gap: '12px', alignItems: 'baseline' } },
    createElement('span', { style: { opacity: 0.6, minWidth: '104px' } }, label),
    createElement('span', null, value),
  );
}

/** Left-rail entry: the icon that selects the workbench panel. */
function PanelIcon(props: StandardProps): unknown {
  const t = tr(props);
  return createElement(
    'div',
    {
      title: t('nav.label'),
      style: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px' },
    },
    createElement(
      'svg',
      {
        width: 20,
        height: 20,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      createElement('path', { d: 'M12 3v18' }),
      createElement('path', { d: 'M7 6c0 3 2 4 5 4s5-1 5-4' }),
      createElement('path', { d: 'M7 12c0 3 2 4 5 4s5-1 5-4' }),
    ),
  );
}

/** Session-header action: same selection, reachable without the rail. */
function HeaderAction(props: StandardProps, ctx: ClientCtx): unknown {
  const t = tr(props);
  return createElement(
    'button',
    { type: 'button', style: buttonStyle, onClick: () => ctx.layout.selectPanel(PANEL_KEY) },
    t('switch.panel'),
  );
}

/** The workbench surface: policy + recent sessions, read from the host route. */
function WorkbenchPanel(props: StandardProps, ctx: ClientCtx): unknown {
  const t = tr(props);
  const config = globalConfig();
  const [state, setState] = useState<StateView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(ROUTE, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as StateView;
        if (alive) {
          setState(payload);
          setError(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const policy = state?.policy ?? {};
  const sessions = state?.sessions ?? [];
  const toggle = (value: boolean | undefined): string =>
    value === undefined ? '—' : value ? t('wb.on') : t('wb.off');

  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'auto',
        padding: '20px 24px',
        font: '13px/1.6 system-ui, sans-serif',
        gap: '12px',
      },
    },
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      createElement('strong', { style: { fontSize: '16px' } }, t('panel.title')),
      createElement('span', { style: chipStyle }, `v${state?.version ?? __CADUCEUS_VERSION__}`),
      createElement('span', { style: { flex: 1 } }),
      createElement(
        'button',
        { type: 'button', style: buttonStyle, onClick: () => ctx.layout.selectPanel(null) },
        t('workbench.back'),
      ),
    ),

    error !== null
      ? createElement('div', { style: { color: '#e06c75' } }, `${t('wb.error')} · ${error}`)
      : null,

    createElement(
      'div',
      { style: blockStyle },
      createElement('strong', null, t('wb.policy')),
      Row(t('wb.transcript'), valueLabel(t, policy.transcript)),
      Row(t('wb.collapse'), valueLabel(t, policy.collapseTiming)),
      Row(t('wb.folded'), valueLabel(t, policy.foldedReplies)),
      Row(t('wb.usage'), valueLabel(t, policy.performance)),
      Row(t('wb.code'), toggle(policy.developerTools)),
    ),

    createElement(
      'div',
      { style: blockStyle },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        createElement('strong', null, t('wb.sessions')),
        createElement('span', { style: { flex: 1 } }),
        createElement(
          'button',
          {
            type: 'button',
            style: buttonStyle,
            onClick: () => {
              setState(null);
              setError(null);
            },
          },
          t('wb.refresh'),
        ),
      ),
      state === null && error === null
        ? createElement('div', { style: { opacity: 0.6 } }, t('wb.loading'))
        : null,
      sessions.length === 0 && state !== null
        ? createElement('div', { style: { opacity: 0.6 } }, t('wb.empty'))
        : null,
      ...sessions.map((row: SessionRow) =>
        createElement(
          'div',
          {
            key: row.sessionId,
            style: { display: 'flex', gap: '14px', padding: '4px 0', borderTop: '1px solid rgba(255,255,255,0.06)' },
          },
          createElement('span', { style: { ...chipStyle, minWidth: '160px' } }, row.sessionId),
          createElement('span', null, `${row.messages ?? 0} ${t('wb.messages')}`),
          createElement('span', null, `${row.rounds ?? 0} ${t('wb.turn')}`),
          createElement('span', null, `${row.steps ?? 0} ${t('wb.step')}`),
          createElement('span', null, `${row.totalTokens ?? 0} ${t('wb.tok')}`),
          row.tokensPerSecond === undefined
            ? null
            : createElement(
                'span',
                { style: chipStyle },
                `${Math.round(row.tokensPerSecond)} ${t('wb.rate')}`,
              ),
        ),
      ),
    ),

    createElement(
      'div',
      { style: { ...chipStyle, opacity: 0.5 } },
      `${t('wb.source')} · ${t('workbench.lang')}: ${config?.lang ?? 'zh'}`,
    ),
  );
}

/** General-settings row: reports the host-side configuration. */
function SettingsRow(props: StandardProps): unknown {
  const t = tr(props);
  const config = globalConfig();
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px 0' } },
    createElement('strong', null, t('settings.title')),
    createElement(
      'span',
      { style: { opacity: 0.7, font: '12px/1.5 system-ui, sans-serif' } },
      `${t('settings.lang')}: ${config?.lang ?? 'zh'} · ${t('settings.metrics')}: ${
        config?.metrics ?? 'compact'
      } · ${t('settings.busyMode')}: ${config?.busyMode ?? 'queue'}`,
    ),
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: ZH, en: EN }),
    'caduceus: client dictionaries',
  );

  // The workbench is a second key on the keyed `main` slot, not an overlay.
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_KEY, locale: NS },
          (props) => WorkbenchPanel(props, ctx),
        ),
      ),
    'caduceus: main panel',
  );

  // Left rail entry: same id as the panel key, so clicking selects the page.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 70,
            locale: NS,
            label: () => '双蛇杖',
          },
          PanelIcon,
        ),
      ),
    'caduceus: sidebar entry',
  );

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'caduceus', order: 40, locale: NS },
          (props) => HeaderAction(props, ctx),
        ),
      ),
    'caduceus: header action',
  );

  ctx.effect(
    () =>
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          { name: 'settings.general.item', id: 'caduceus', order: 40, locale: NS },
          SettingsRow,
        ),
      ),
    'caduceus: settings row',
  );
}
