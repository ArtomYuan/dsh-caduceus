/** Minimal React surface used by the client half; react is provided by dsh's module table. */
declare module 'react' {
  export interface ReactElement {
    readonly type: unknown;
    readonly props: unknown;
  }
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElement;
  export function useState<T>(initial: T): [T, (value: T) => void];
}
