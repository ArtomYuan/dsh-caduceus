/**
 * Persona startup auto-sync: keep the projection in `<DSH_HOME>/AGENTS.md`
 * fresh without requiring a manual `/persona sync` after every SOUL edit.
 *
 * Contract:
 * - runs once per gateway startup, BEFORE the Feishu long connection starts
 *   (so it is always ahead of the first inbound message);
 * - idempotent: `syncSoul()` returns `unchanged` without writing the file when
 *   the block already matches the SOUL source;
 * - missing source is a no-op: no empty `AGENTS.md` is created;
 * - malformed targets are skipped with a warning;
 * - any unexpected error is caught and logged as one warning — startup never
 *   fails because of the persona projection.
 *
 * @module @artomyuan/dsh-caduceus/persona/auto-sync
 */
import type { HomeEnv } from '../home.js';
import { silentLogger, type LoggerLike } from '../logger.js';
import { syncSoul } from './blocks.js';

export interface PersonaAutoSyncOptions {
  /** `personaAutoSync` config; defaults to true. `false` = zero calls. */
  readonly enabled?: boolean;
  readonly env?: HomeEnv;
  readonly logger?: LoggerLike;
  /** Injectable seam for tests (defaults to the real syncSoul). */
  readonly sync?: typeof syncSoul;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the one-shot persona projection sync. Never throws. */
export async function autoSyncPersona(options: PersonaAutoSyncOptions = {}): Promise<void> {
  if (options.enabled === false) return;
  const logger = options.logger ?? silentLogger();
  try {
    const result = await (options.sync ?? syncSoul)({
      ...(options.env === undefined ? {} : { env: options.env }),
      logger,
    });
    switch (result.status) {
      case 'created':
      case 'updated':
      case 'unchanged':
        logger.info(
          `persona: synced soulBytes=${result.soulBytes} agentsBytes=${result.agentsBytes} status=${result.status}`,
        );
        return;
      case 'missing':
        // Missing SOUL sources are intentional no-ops: never create AGENTS.md.
        logger.info('persona: source missing; skipped');
        return;
      case 'malformed':
        logger.warn('persona: sync skipped (malformed)');
        return;
      case 'invalid':
        logger.warn('persona: sync skipped (invalid)');
        return;
    }
  } catch (error) {
    logger.warn(`persona auto-sync failed: ${errorMessage(error)}`);
  }
}
