/**
 * Durable session ownership (`meta.caduceus`) for dsh-caduceus sessions.
 *
 * Session ids are `feishu-<epoch_ms>` and dsh's own session header has no room
 * for our fields (dsh 0.2.1-rc.2 rebuilds the header from its known meta keys,
 * so an unknown `meta.caduceus` is ignored at runtime). Ownership is therefore
 * written by caduceus itself:
 *
 * - `<DSH_HOME>/caduceus/owners/<sessionId>.json` — always written at
 *   create/resume time (atomic);
 * - additionally, the startup scanner accepts ownership embedded in a plain
 *   session-log header/first lines (`meta.caduceus` / `caduceus`), which is
 *   what tests and future dsh versions may provide.
 *
 * `agents.create` still receives `meta: { cwd, caduceus }` as required by the
 * integration contract; the sidecar is the part that actually survives.
 *
 * @module dsh-caduceus/ownership
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { dshHome, type HomeEnv } from './home.js';

/** Ordinary-group isolation kind recorded with a session. */
export type SessionScopeKind = 'p2p' | 'topic' | 'group-user';

/** The ownership payload stored in `meta.caduceus`. */
export interface SessionOwnershipMeta {
  readonly chatId: string;
  readonly scopeKey: string;
  readonly kind: SessionScopeKind;
}

export interface OwnershipOptions {
  /** Explicit owners directory (tests); defaults to `<DSH_HOME>/caduceus/owners`. */
  readonly dir?: string;
  readonly env?: HomeEnv;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const KINDS = new Set<SessionScopeKind>(['p2p', 'topic', 'group-user']);

/** Validate one parsed ownership object. */
export function parseOwnership(value: unknown): SessionOwnershipMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { chatId, scopeKey, kind } = record;
  if (typeof chatId !== 'string' || chatId.length === 0) return undefined;
  if (typeof scopeKey !== 'string' || scopeKey.length === 0) return undefined;
  if (typeof kind !== 'string' || !KINDS.has(kind as SessionScopeKind)) return undefined;
  return { chatId, scopeKey, kind: kind as SessionScopeKind };
}

/** Pull ownership out of a `meta.caduceus` / `caduceus` shaped record. */
export function ownershipFromRecord(record: unknown): SessionOwnershipMeta | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const value = record as Record<string, unknown>;
  const direct = parseOwnership(value['caduceus']);
  if (direct !== undefined) return direct;
  const meta = value['meta'];
  if (typeof meta === 'object' && meta !== null) {
    const fromMeta = parseOwnership((meta as Record<string, unknown>)['caduceus']);
    if (fromMeta !== undefined) return fromMeta;
  }
  const data = value['data'];
  if (typeof data === 'object' && data !== null) {
    const fromData = ownershipFromRecord(data);
    if (fromData !== undefined) return fromData;
  }
  return undefined;
}

/** Owners directory (created lazily when writing). */
export function ownershipDir(options: OwnershipOptions = {}): string {
  return options.dir ?? join(dshHome(options.env), 'caduceus', 'owners');
}

/** Sidecar path for one session. */
export function ownershipPath(sessionId: string, options: OwnershipOptions = {}): string {
  if (!SAFE_ID.test(sessionId)) throw new TypeError(`unsafe session id: ${sessionId}`);
  return join(ownershipDir(options), `${sessionId}.json`);
}

/** Persist ownership atomically. */
export async function writeOwnership(
  sessionId: string,
  meta: SessionOwnershipMeta,
  options: OwnershipOptions = {},
): Promise<void> {
  await writeFileAtomic(
    ownershipPath(sessionId, options),
    `${JSON.stringify({ caduceus: meta }, null, 2)}\n`,
  );
}

/** Read the sidecar ownership, if present and valid. */
export function readOwnership(
  sessionId: string,
  options: OwnershipOptions = {},
): SessionOwnershipMeta | undefined {
  try {
    return ownershipFromRecord(
      JSON.parse(readFileSync(ownershipPath(sessionId, options), 'utf8')) as unknown,
    );
  } catch {
    return undefined;
  }
}

/**
 * Read ownership from a session directory: sidecar file first, then the first
 * lines of any plain `*.jsonl*` file (header/`session/created`/plugin record).
 * Compressed generations are intentionally not decoded (sidecar covers the
 * sessions this package creates).
 */
export function readOwnershipFromSessionDir(sessionDir: string): SessionOwnershipMeta | undefined {
  try {
    const entries = readdirSync(sessionDir);
    const sidecar = entries.find((name) => name === 'caduceus-owner.json');
    if (sidecar !== undefined) {
      try {
        const value = JSON.parse(readFileSync(join(sessionDir, sidecar), 'utf8')) as unknown;
        const meta = ownershipFromRecord(value);
        if (meta !== undefined) return meta;
      } catch {
        // Try the log lines below.
      }
    }
    for (const name of entries) {
      if (!name.includes('.jsonl') || name.includes('.zstd')) continue;
      let lines: string[];
      try {
        lines = readFileSync(join(sessionDir, name), 'utf8').split('\n');
      } catch {
        continue;
      }
      for (const line of lines.slice(0, 20)) {
        if (line.trim().length === 0) continue;
        try {
          const meta = ownershipFromRecord(JSON.parse(line) as unknown);
          if (meta !== undefined) return meta;
        } catch {
          // Malformed line: keep looking.
        }
      }
    }
  } catch {
    // Unreadable directory: no ownership.
  }
  return undefined;
}

/** True when the path exists (small helper for tests/backfill). */
export function ownershipFileExists(sessionId: string, options: OwnershipOptions = {}): boolean {
  try {
    return existsSync(ownershipPath(sessionId, options));
  } catch {
    return false;
  }
}
