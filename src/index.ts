/**
 * `caduceus-gateway` cordis entry — the bundle row `caduceus-gateway` in
 * `cordis.patch.yml` resolves to this package root.
 *
 * Slice 1 scaffold only: the row must mount so the composed profile is valid,
 * but the Feishu transport, the session bridge, and the turn loop land in
 * slice 2. Keep this module side-effect free and dependency free until then.
 *
 * @module @artomyuan/dsh-caduceus
 */

/** Stable cordis plugin name; must match the bundle row id. */
export const name = 'caduceus-gateway';

/**
 * Mount point. Intentionally empty in slice 1 (no services requested, no
 * listeners registered, no timers).
 */
export function apply(): void {
  // Slice 2: inject session/agent/commands services and mount the gateway.
}
