/**
 * `caduceus-persona` cordis entry — the bundle row `caduceus-persona` in
 * `cordis.patch.yml` resolves to this subpath export.
 *
 * Slice 1 scaffold only: `/persona show|sync` wiring lands with the command
 * handler in slice 2. The file-level logic already lives in `./blocks.ts`,
 * which is fully unit-tested without a running dsh.
 *
 * @module @artomyuan/dsh-caduceus/persona
 */

/** Stable cordis plugin name; must match the bundle row id. */
export const name = 'caduceus-persona';

/** Mount point. Intentionally empty in slice 1. */
export function apply(): void {
  // Slice 2: expose the persona sync through the command registry.
}
