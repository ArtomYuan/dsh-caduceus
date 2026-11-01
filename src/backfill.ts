/**
 * Startup ownership backfill: match dsh session directories to the caduceus
 * ownership sidecar (or an ownership-carrying plain JSONL header) and append
 * the session id to that scope key's history, so old sessions stay reachable
 * even after a restart / history loss.
 *
 * Read-only scan of `<DSH_HOME>/sessions/<bucket>/<sessionId>/`; never creates
 * agents or sessions. Session-map writes are the only side effect.
 *
 * @module dsh-caduceus/backfill
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { dshHome, type HomeEnv } from './home.js';
import type { LoggerLike } from './logger.js';
import { silentLogger } from './logger.js';
import {
  readOwnership,
  readOwnershipFromSessionDir,
  type OwnershipOptions,
} from './ownership.js';
import type { SessionStore } from './session-key.js';

export interface SessionDirEntry {
  readonly sessionId: string;
  readonly dir: string;
}

export interface BackfillOptions {
  /** Sessions root; defaults to `<DSH_HOME>/sessions`. */
  readonly root?: string;
  readonly env?: HomeEnv;
  readonly ownership?: OwnershipOptions;
  readonly logger?: LoggerLike;
}

export interface BackfillResult {
  readonly scanned: number;
  readonly adopted: number;
  readonly skipped: number;
}

/** Discover caduceus-minted session directories (`feishu-*`), sorted for determinism. */
export function scanSessionDirs(options: BackfillOptions = {}): SessionDirEntry[] {
  const root = options.root ?? join(dshHome(options.env), 'sessions');
  const found: SessionDirEntry[] = [];
  let buckets: string[];
  try {
    buckets = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return found;
  }
  for (const bucket of buckets) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, bucket), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('feishu-'))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const sessionId of entries) {
      found.push({ sessionId, dir: join(root, bucket, sessionId) });
    }
  }
  return found;
}

/**
 * Adopt discovered sessions into their owning scope key's history.
 * Idempotent: a second run adopts 0.
 */
export function backfillSessionOwnership(
  store: SessionStore,
  options: BackfillOptions = {},
): BackfillResult {
  const logger = options.logger ?? silentLogger();
  const ownershipOptions = options.ownership ?? {};
  let scanned = 0;
  let adopted = 0;
  let skipped = 0;

  for (const entry of scanSessionDirs(options)) {
    scanned += 1;
    const meta =
      readOwnership(entry.sessionId, ownershipOptions) ??
      readOwnershipFromSessionDir(entry.dir);
    if (meta === undefined) {
      skipped += 1;
      continue;
    }
    if (store.appendHistory(meta.scopeKey, entry.sessionId)) adopted += 1;
  }

  logger.info(`backfill: scanned=${scanned} adopted=${adopted} skipped=${skipped}`);
  return { scanned, adopted, skipped };
}
