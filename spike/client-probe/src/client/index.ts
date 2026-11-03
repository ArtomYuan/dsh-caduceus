/**
 * Probe client half: register one fixed-position label in the shell overlay.
 * Kept dependency-light so the experiment proves the plugin-build path, not a
 * UI framework integration.
 */
import React from 'react';

export const inject = ['slots'];

function ProbeLabel(): unknown {
  return React.createElement(
    'div',
    {
      style: {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: 9999,
        padding: '4px 8px',
        borderRadius: '6px',
        background: 'rgba(20, 20, 24, 0.85)',
        color: '#fff',
        font: '12px/1.4 system-ui, sans-serif',
        pointerEvents: 'none',
      },
    },
    'caduceus client probe',
  );
}

export function apply(ctx: {
  effect(callback: () => () => void, label?: string): void;
  slots: {
    register(
      spec: { name: 'shell.overlay' },
      component: () => unknown,
    ): () => void;
  };
}): void {
  ctx.effect(
    () => ctx.slots.register({ name: 'shell.overlay' }, ProbeLabel),
    'caduceus-client-probe: label',
  );
}
