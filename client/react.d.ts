/**
 * Minimal React surface used by this plugin's browser half. The bundle treats
 * `react` as a platform-provided external (see tsdown.client.mjs), so only the
 * few members this code calls need declaring.
 */
declare module 'react' {
  export interface ReactElement {
    readonly type: unknown;
  }
  export type ReactNode = unknown;
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElement;
  export function useState<T>(initial: T): [T, (next: T) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
