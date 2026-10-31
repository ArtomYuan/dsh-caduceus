/**
 * Chat/topic ↔ session mapping for the Feishu surface (design doc §8).
 *
 * One Feishu topic is one dsh session: the scope key is
 * `chatId + "\u0000" + threadId`, with a plain `chatId` for chats without a
 * topic. The mapping persists as `<DSH_HOME>/caduceus/session-map.json` in
 * format **v3**:
 *
 * ```json
 * {
 *   "version": 3,
 *   "entries": { "oc_x\u0000omt_y": { "sessionId": "feishu-1793313252045" } },
 *   "cwd": { "oc_x\u0000omt_y": "/home/artom/.dsh/workspace" }
 * }
 * ```
 *
 * Older maps still load: v2 is a flat `{ "<scope key>": "feishu-<ts>" }` object
 * and v1 nests those strings under `sessions`. Migrated keys are preserved
 * verbatim as-is (no key rewriting, no bulk re-key); the next persist writes v3.
 * Loading never writes: a read must not rewrite the user's file.
 *
 * @module @artomyuan/dsh-caduceus/session-key
 */
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic-write.js';
import { defaultSessionMapPath, type HomeEnv } from './home.js';

/** Current on-disk format. */
export const SESSION_MAP_VERSION = 3;

/** Separator between chat id and thread id inside a scope key (NUL byte). */
export const SCOPE_KEY_SEPARATOR = '\u0000';

/**
 * The scope key for a chat, optionally disambiguated by a topic/thread.
 * @param chatId - Feishu chat id (`oc_…`).
 * @param threadId - Feishu thread id (`omt_…`); empty/null means "no topic".
 * @returns `chatId` alone, or `chatId + "\u0000" + threadId`.
 */
export function scopeKey(chatId: string, threadId?: string | null): string {
  if (chatId.length === 0) throw new TypeError('scopeKey: chatId must be a non-empty string');
  return threadId !== undefined && threadId !== null && threadId.length > 0
    ? `${chatId}${SCOPE_KEY_SEPARATOR}${threadId}`
    : chatId;
}

/** A minted dsh session id. */
export type SessionIdMinter = () => string;

let lastMintedAt = 0;

/**
 * Mint a fresh session id, `feishu-<epoch-ms>`. Monotonic within the process so
 * two sessions created in the same millisecond never collide.
 */
export function mintSessionId(): string {
  const now = Date.now();
  lastMintedAt = now > lastMintedAt ? now : lastMintedAt + 1;
  return `feishu-${lastMintedAt}`;
}

/** One mapping entry in v3. */
export interface SessionEntry {
  readonly sessionId: string;
}

/** The v3 on-disk document. */
export interface SessionMapV3 {
  readonly version: typeof SESSION_MAP_VERSION;
  readonly entries: Record<string, SessionEntry>;
  readonly cwd: Record<string, string>;
}

export interface SessionStoreOptions {
  /** Absolute path of the map file; defaults to `$DSH_HOME/caduceus/session-map.json`. */
  readonly filePath?: string;
  /** Environment used only to resolve the default path. */
  readonly env?: HomeEnv;
  /** Session-id minter; injectable for deterministic tests. */
  readonly mint?: SessionIdMinter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extract a session id from either a v3 entry object or a v1/v2 bare string. */
function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (isRecord(value)) {
    const sessionId = value['sessionId'];
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId;
  }
  return undefined;
}

/**
 * Durable scope-key → session-id store.
 *
 * `load()` must be called before any accessor; it never throws and never writes.
 * Mutations persist atomically (temp file + rename) immediately.
 */
export class SessionStore {
  /** Absolute path of the JSON map. */
  readonly filePath: string;

  private readonly mint: SessionIdMinter;
  private readonly entries = new Map<string, string>();
  private readonly cwds = new Map<string, string>();
  private readonly warningLog: string[] = [];
  private loaded = false;

  constructor(options: SessionStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultSessionMapPath(options.env);
    this.mint = options.mint ?? mintSessionId;
  }

  /** True between `load()` and the next `load()`. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Non-fatal diagnostics accumulated by the last `load()`. */
  get warnings(): readonly string[] {
    return this.warningLog;
  }

  /** Number of mapped scopes. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Read the map from disk. A missing file yields an empty map; a corrupt or
   * unsupported file also yields an empty map plus a warning. Never throws for
   * I/O or format problems, so a bad file cannot take the surface down.
   */
  load(): this {
    this.entries.clear();
    this.cwds.clear();
    this.warningLog.length = 0;
    this.loaded = true;

    let text: string;
    try {
      text = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`cannot read session map ${this.filePath}: ${errorMessage(error)}`);
      }
      return this;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.warn(`session map ${this.filePath} is not valid JSON; starting with an empty map`);
      return this;
    }
    if (!isRecord(parsed)) {
      this.warn(`session map ${this.filePath} is not a JSON object; starting with an empty map`);
      return this;
    }

    const version = parsed['version'];
    if (version === SESSION_MAP_VERSION) {
      this.loadV3(parsed);
    } else if (version === 1) {
      this.loadV1(parsed);
    } else if (version === 2) {
      this.loadV2(parsed);
    } else if (version === undefined) {
      // No version marker: v1 has a `sessions` object, v2 is the flat map.
      if (isRecord(parsed['sessions'])) this.loadV1(parsed);
      else this.loadV2(parsed);
    } else {
      this.warn(`session map ${this.filePath} has unsupported version ${JSON.stringify(version)}; starting with an empty map`);
    }
    return this;
  }

  /** @throws when called before `load()`. */
  get(key: string): string | undefined {
    this.requireLoaded();
    return this.entries.get(key);
  }

  /** @throws when called before `load()`. */
  has(key: string): boolean {
    this.requireLoaded();
    return this.entries.has(key);
  }

  /** @throws when called before `load()`. */
  keys(): string[] {
    this.requireLoaded();
    return [...this.entries.keys()];
  }

  /** Bind a key to a session id and persist. @throws when called before `load()`. */
  set(key: string, sessionId: string): void {
    this.requireLoaded();
    if (key.length === 0) throw new TypeError('session map: key must be a non-empty string');
    if (sessionId.length === 0) throw new TypeError('session map: sessionId must be a non-empty string');
    this.entries.set(key, sessionId);
    this.persist();
  }

  /**
   * Return the key's session id, minting and persisting one when absent.
   * @throws when called before `load()`, or when the minter returns an empty or
   *   already-used id.
   */
  ensure(key: string, mint: SessionIdMinter = this.mint): string {
    this.requireLoaded();
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    if (key.length === 0) throw new TypeError('session map: key must be a non-empty string');
    const sessionId = mint();
    if (sessionId.length === 0) throw new Error('session map: minter returned an empty session id');
    for (const [otherKey, otherId] of this.entries) {
      if (otherId === sessionId && otherKey !== key) {
        throw new Error(`session map: minter returned duplicate session id ${sessionId}`);
      }
    }
    this.entries.set(key, sessionId);
    this.persist();
    return sessionId;
  }

  /** Remove a key and persist. @throws when called before `load()`. */
  delete(key: string): boolean {
    this.requireLoaded();
    const deleted = this.entries.delete(key);
    if (deleted) this.persist();
    return deleted;
  }

  /** Working directory pinned to a scope key, if any. */
  getCwd(key: string): string | undefined {
    this.requireLoaded();
    return this.cwds.get(key);
  }

  /** Pin a working directory to a scope key and persist. */
  setCwd(key: string, cwd: string): void {
    this.requireLoaded();
    if (key.length === 0) throw new TypeError('session map: key must be a non-empty string');
    if (cwd.length === 0) throw new TypeError('session map: cwd must be a non-empty string');
    this.cwds.set(key, cwd);
    this.persist();
  }

  /** Remove a pinned working directory and persist. */
  deleteCwd(key: string): boolean {
    this.requireLoaded();
    const deleted = this.cwds.delete(key);
    if (deleted) this.persist();
    return deleted;
  }

  /** A plain v3 snapshot, suitable for JSON serialization in tests and logs. */
  snapshot(): SessionMapV3 {
    this.requireLoaded();
    const entries: Record<string, SessionEntry> = {};
    for (const [key, sessionId] of this.entries) entries[key] = { sessionId };
    const cwd: Record<string, string> = {};
    for (const [key, value] of this.cwds) cwd[key] = value;
    return { version: SESSION_MAP_VERSION, entries, cwd };
  }

  /** Atomically write the current map as v3 (temp file beside the target, then rename). */
  persist(): void {
    this.requireLoaded();
    writeFileAtomicSync(this.filePath, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }

  private loadV1(document: Record<string, unknown>): void {
    const sessions = document['sessions'];
    if (!isRecord(sessions)) {
      this.warn(`session map ${this.filePath}: v1 document has no sessions object; starting with an empty map`);
      return;
    }
    for (const [key, value] of Object.entries(sessions)) {
      const sessionId = sessionIdOf(value);
      if (sessionId === undefined) this.warn(`session map ${this.filePath}: v1 entry ${JSON.stringify(key)} is not a session id; skipped`);
      else this.entries.set(key, sessionId);
    }
    this.loadCwdTable(document, ['cwd', 'cwds']);
  }

  private loadV2(document: Record<string, unknown>): void {
    const reserved = new Set(['version', 'entries', 'sessions', 'cwd', 'cwds']);
    for (const [key, value] of Object.entries(document)) {
      if (reserved.has(key)) continue;
      const sessionId = sessionIdOf(value);
      if (sessionId === undefined) this.warn(`session map ${this.filePath}: v2 entry ${JSON.stringify(key)} is not a session id; skipped`);
      else this.entries.set(key, sessionId);
    }
    this.loadCwdTable(document, ['cwd', 'cwds']);
  }

  private loadV3(document: Record<string, unknown>): void {
    const entries = document['entries'];
    if (isRecord(entries)) {
      for (const [key, value] of Object.entries(entries)) {
        const sessionId = sessionIdOf(value);
        if (sessionId === undefined) this.warn(`session map ${this.filePath}: v3 entry ${JSON.stringify(key)} has no sessionId; skipped`);
        else this.entries.set(key, sessionId);
      }
    } else {
      this.warn(`session map ${this.filePath}: v3 document has no entries object; starting with an empty map`);
    }
    this.loadCwdTable(document, ['cwd']);
  }

  private loadCwdTable(document: Record<string, unknown>, keys: readonly string[]): void {
    for (const tableKey of keys) {
      const table = document[tableKey];
      if (table === undefined) continue;
      if (!isRecord(table)) {
        this.warn(`session map ${this.filePath}: ${tableKey} is not an object; ignored`);
        continue;
      }
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'string' && value.length > 0) this.cwds.set(key, value);
        else this.warn(`session map ${this.filePath}: ${tableKey} entry ${JSON.stringify(key)} is not a path; skipped`);
      }
    }
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error('session map: load() must be called before reading or writing');
  }

  private warn(message: string): void {
    this.warningLog.push(message);
  }
}
