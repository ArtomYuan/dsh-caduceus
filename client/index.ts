/**
 * Browser half of dsh-caduceus. It contributes only to additive list slots:
 * a Session-header action button and a General-settings row. The drawer it
 * opens is rendered by this module (fixed-position DOM), not by a host panel.
 */
import { createElement } from 'react';
import { EN, FALLBACK, NS, ZH, type LabelKey } from './labels.ts';

declare const __CADUCEUS_VERSION__: string;

export const inject = ['slots', 'locale'];

interface StandardProps {
  readonly t?: (key: LabelKey) => string;
  readonly sessionId?: string;
}

interface ClientConfig {
  readonly lang?: string;
  readonly metrics?: string;
  readonly busyMode?: string;
}

type SlotName = 'conversation.session.header.actions' | 'settings.general.item';

interface ClientCtx {
  readonly locale: {
    register(
      namespace: string,
      dictionaries: { zh: Record<string, string>; en: Record<string, string> },
    ): () => void;
  };
  readonly slots: {
    register(
      spec: {
        name: SlotName;
        id: string;
        order: number;
        locale?: string;
      },
      component: (props: StandardProps) => unknown,
    ): () => void;
    /** Wait for another entry's declaration, then contribute (facade: {inject, register}). */
    inject(name: SlotName, contribute: () => () => void): () => void;
  };
  effect(callback: () => () => void, label?: string): void;
}

function tr(props: StandardProps): (key: LabelKey) => string {
  return props.t ?? ((key) => FALLBACK[key]);
}

function globalConfig(): ClientConfig | undefined {
  return (globalThis as { __CADUCEUS_CLIENT_CONFIG__?: ClientConfig })
    .__CADUCEUS_CLIENT_CONFIG__;
}

/** Self-rendered drawer: no main panel, no shell.overlay, no host-owned slots. */
function openDrawer(props: StandardProps): void {
  if (typeof document === 'undefined') return;
  document.getElementById('caduceus-drawer')?.remove();
  const t = tr(props);
  const root = document.createElement('div');
  root.id = 'caduceus-drawer';
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '10000',
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  });
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(560px, calc(100vw - 32px))',
    margin: '16px',
    padding: '20px',
    borderRadius: '12px',
    background: '#17171d',
    color: '#fff',
    boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
    font: '14px/1.6 system-ui, sans-serif',
  });
  const title = document.createElement('h2');
  title.textContent = t('panel.title');
  Object.assign(title.style, { margin: '0 0 12px', fontSize: '18px' });
  const version = document.createElement('p');
  version.textContent = `${t('panel.version')} ${__CADUCEUS_VERSION__}`;
  const session = document.createElement('p');
  session.textContent = `${t('drawer.session')}: ${props.sessionId ?? t('drawer.none')}`;
  const loaded = document.createElement('p');
  loaded.textContent = t('panel.loaded');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = t('drawer.close');
  Object.assign(close.style, {
    marginTop: '12px',
    padding: '4px 12px',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '6px',
    background: 'transparent',
    color: '#fff',
    cursor: 'pointer',
  });
  const dismiss = (): void => root.remove();
  close.addEventListener('click', dismiss);
  root.addEventListener('click', (event) => {
    if (event.target === root) dismiss();
  });
  panel.append(title, version, session, loaded, close);
  root.append(panel);
  document.body.append(root);
}

function HeaderAction(props: StandardProps): unknown {
  const t = tr(props);
  return createElement(
    'button',
    {
      type: 'button',
      style: {
        padding: '4px 10px',
        border: '1px solid rgba(255,255,255,0.25)',
        borderRadius: '6px',
        background: 'transparent',
        color: 'inherit',
        font: '12px/1.4 system-ui, sans-serif',
        cursor: 'pointer',
      },
      onClick: () => openDrawer(props),
    },
    t('switch.panel'),
  );
}

function SettingsItem(props: StandardProps): unknown {
  const t = tr(props);
  const config = globalConfig();
  const value = config === undefined
    ? t('settings.unavailable')
    : `${t('settings.lang')}: ${config.lang ?? '-'} · ` +
      `${t('settings.metrics')}: ${config.metrics ?? '-'} · ` +
      `${t('settings.busyMode')}: ${config.busyMode ?? '-'}`;
  return createElement(
    'div',
    { style: { padding: '8px 0', font: '13px/1.5 system-ui, sans-serif' } },
    createElement('div', { style: { fontWeight: 600 } }, t('settings.title')),
    createElement('div', { style: { opacity: 0.75 } }, value),
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: ZH, en: EN }),
    'caduceus: client dictionaries',
  );
  try {
    console.info('[caduceus] apply start');
    registerWhenDeclared(ctx, 'conversation.session.header.actions', HeaderAction, 'headerAction');
    registerWhenDeclared(ctx, 'settings.general.item', SettingsItem, 'settingsRow');
    console.info('[caduceus] apply ok');
  } catch (error) {
    console.error('[caduceus] apply failed:', (error as Error)?.message ?? error);
  }
}

/**
 * Contribute into a slot another entry declares.
 *
 * Boot order is not ours: the UI packages declare these slots after this entry
 * applies, so a bare `register` throws `slot "<name>" is not declared`.
 * `subscribeDeclaration` is the sanctioned wait-for-declaration primitive.
 */
function registerWhenDeclared(
  ctx: ClientCtx,
  name: SlotName,
  component: (props: StandardProps) => unknown,
  id: string,
): void {
  ctx.effect(
    () =>
      ctx.slots.inject(name, () =>
        ctx.slots.register({ name, id: `caduceus-${id}`, order: 40, locale: NS }, component),
      ),
    `caduceus: ${id}`,
  );
}
