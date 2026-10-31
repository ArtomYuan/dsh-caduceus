/**
 * Session-log existence check used to mark "ghost" session-map entries.
 *
 * dsh's JSONL persistence stores one directory per session under
 * `<DSH_HOME>/sessions/<project-bucket>/<sessionId>/` with generation files such
 * as `session.v4.jsonl.zstd`. The bridge only needs a cheap boolean, so this
 * helper scans the bucket level (a handful of directories) and checks for a
 * `*.jsonl*` generation file inside the session directory.
 *
 * Read-only, bounded, and tolerant: a missing root, unreadable bucket, or
 * malformed session id simply reports `false`/is skipped — never throws.
 *
 * @module @artomyuan/dsh-caduceus/session-files
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { dshHome, type HomeEnv } from './home.js';

export interface SessionLogLookup {
  /** Explicit sessions root (tests); defaults to `<DSH_HOME>/sessions`. */
  readonly root?: string;
  readonly env?: HomeEnv;
}

/** Session ids are minted safe names; anything else must not touch the FS path. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;

/** True when any JSONL generation file exists for `sessionId` on disk. */
export function hasSessionLog(sessionId: string, lookup: SessionLogLookup = {}): boolean {
  if (!SAFE_SESSION_ID.test(sessionId)) return false;
  const root = lookup.root ?? join(dshHome(lookup.env), 'sessions');
  let buckets: string[];
  try {
    buckets = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  for (const bucket of buckets) {
    try {
      const files = readdirSync(join(root, bucket, sessionId));
      if (files.some((name) => name.includes('.jsonl'))) return true;
    } catch {
      // No session directory in this bucket; try the next one.
    }
  }
  return false;
}
