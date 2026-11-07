/**
 * `caduceus-workbench` cordis entry — the host half of the browser workbench.
 *
 * Registers one read-only same-origin route prefix (`/caduceus`) on dsh's Web
 * server so the client half can render real numbers without a port, a loopback
 * URL or a CORS exception. That is why this is a host module and not a browser
 * fetch: the Desktop build serves the client over `dsh-app://` and exposes no
 * HTTP server, while a same-origin route keeps working unchanged.
 *
 * Session facts come from dsh's `sessionQuery` service, never from reading the
 * log files directly: session logs are appended as **concatenated zstd frames**,
 * and both `zlib.zstdDecompressSync` and `createZstdDecompress` stop at the
 * first frame (measured: 331 260 bytes on disk → 197 bytes decoded, i.e. only
 * the header line). The service decodes the whole logical log, so it is the
 * only correct source.
 *
 * Nothing here depends on Feishu credentials: with the gateway in idle mode the
 * workbench still reports sessions, usage and the effective card policy.
 *
 * @module dsh-caduceus/workbench
 */
import { createRequire } from 'node:module';

import { aggregateMetrics } from './metrics.js';
import { DEFAULT_CARD_POLICY, cardPolicyFromSettings, type CardPolicy, type SettingsEntryLike } from './card-policy.js';
import { parseSessionEvents } from './export.js';

/** Stable cordis plugin name; must match the bundle row id. */
export const name = 'caduceus-workbench';

/** The only service this entry needs directly (session facts are resolved lazily). */
export const inject = ['webServer'];

/** One session row of the workbench table. */
export interface WorkbenchSession {
  readonly sessionId: string;
  readonly messages: number;
  readonly rounds: number;
  readonly steps: number;
  readonly totalTokens: number;
  readonly tokensPerSecond?: number;
  readonly cacheHitPercent?: number;
}

/** The whole `/caduceus/state` payload. */
export interface WorkbenchState {
  readonly ok: true;
  readonly version: string;
  readonly generatedAt: number;
  readonly policy: CardPolicy;
  readonly sessions: readonly WorkbenchSession[];
  /** `sessionQuery` present? False means the table cannot be filled. */
  readonly sessionsAvailable: boolean;
}

/** Everything the handler reads; injected so the route is testable without dsh. */
export interface WorkbenchDeps {
  readonly version: string;
  readonly policy: () => CardPolicy;
  readonly sessions: () =>
    | { readonly rows: readonly WorkbenchSession[]; readonly available: boolean }
    | Promise<{ readonly rows: readonly WorkbenchSession[]; readonly available: boolean }>;
  readonly now?: () => number;
}

export interface WorkbenchRequest {
  readonly method?: string;
  readonly url?: string;
}
export interface WorkbenchResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function json(res: WorkbenchResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** Reduce one session's raw events to a table row (pure; unit-tested). */
export function summarizeEvents(sessionId: string, events: readonly unknown[]): WorkbenchSession {
  const metrics = aggregateMetrics(events);
  return {
    sessionId,
    messages: parseSessionEvents(events).length,
    rounds: metrics.rounds,
    steps: metrics.steps,
    totalTokens: metrics.totalTokens,
    ...(metrics.tokensPerSecond === undefined ? {} : { tokensPerSecond: metrics.tokensPerSecond }),
    ...(metrics.cacheHitPercent === undefined ? {} : { cacheHitPercent: metrics.cacheHitPercent }),
  };
}

/** Build the `/caduceus/*` handler for one set of deps. */
export function createWorkbenchHandler(
  deps: WorkbenchDeps,
  route = '/caduceus',
): (req: WorkbenchRequest, res: WorkbenchResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.local');
    const sub = url.pathname.startsWith(route) ? url.pathname.slice(route.length) || '/' : undefined;
    if (sub !== '/' && sub !== '/state') {
      json(res, 404, { error: 'not-found' });
      return;
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end();
      return;
    }
    let rows: readonly WorkbenchSession[] = [];
    let available = false;
    try {
      const result = await deps.sessions();
      rows = result.rows;
      available = result.available;
    } catch {
      rows = [];
      available = false;
    }
    const state: WorkbenchState = {
      ok: true,
      version: deps.version,
      generatedAt: (deps.now ?? Date.now)(),
      policy: deps.policy(),
      sessions: rows,
      sessionsAvailable: available,
    };
    json(res, 200, state);
  };
}

interface SessionQueryLike {
  filterSessions(filters: readonly unknown[]): Promise<readonly { header?: { id?: unknown } }[]>;
  readSession(sessionId: string): Promise<{ events?: readonly unknown[] }>;
}

interface WorkbenchConfig {
  readonly limit?: number;
  readonly lang?: string;
}

interface WorkbenchContext {
  readonly get?: (name: string) => unknown;
  readonly settings?: unknown;
  readonly webServer: {
    register(spec: {
      kind: 'prefix';
      path: string;
      handler: (req: WorkbenchRequest, res: WorkbenchResponse) => Promise<void> | void;
    }): unknown;
  };
  readonly effect: (callback: () => unknown, label?: string) => void;
  readonly logger?: { warn?: (message: string) => void };
}

/** Resolve dsh's live settings service defensively (it may not exist yet). */
function policyReader(ctx: WorkbenchContext): () => CardPolicy {
  const service = (): { describe?: () => readonly SettingsEntryLike[] } | undefined => {
    try {
      const direct = (ctx as { settings?: unknown }).settings;
      if (direct !== undefined) return direct as { describe?: () => readonly SettingsEntryLike[] };
      return ctx.get?.('settings') as { describe?: () => readonly SettingsEntryLike[] } | undefined;
    } catch {
      return undefined;
    }
  };
  return () => {
    try {
      return cardPolicyFromSettings(service()?.describe?.());
    } catch {
      return DEFAULT_CARD_POLICY;
    }
  };
}

/** Session rows via `sessionQuery`, newest first, cached briefly. */
function sessionReader(
  ctx: WorkbenchContext,
  limit: number,
): () => Promise<{ rows: readonly WorkbenchSession[]; available: boolean }> {
  let cachedAt = 0;
  let cached: { rows: readonly WorkbenchSession[]; available: boolean } = {
    rows: [],
    available: false,
  };
  return async () => {
    const now = Date.now();
    if (now - cachedAt < 10_000) return cached;
    cachedAt = now;
    const query = (() => {
      try {
        return ctx.get?.('sessionQuery') as SessionQueryLike | undefined;
      } catch {
        return undefined;
      }
    })();
    if (query === undefined) {
      cached = { rows: [], available: false };
      return cached;
    }
    const rows: WorkbenchSession[] = [];
    try {
      const records = await query.filterSessions([]);
      const ids = records
        .map((record) => (typeof record.header?.id === 'string' ? record.header.id : undefined))
        .filter((id): id is string => id !== undefined)
        .slice(0, limit);
      for (const id of ids) {
        try {
          const snapshot = await query.readSession(id);
          rows.push(summarizeEvents(id, snapshot.events ?? []));
        } catch (error) {
          ctx.logger?.warn?.(`caduceus-workbench: could not read ${id}: ${String(error)}`);
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`caduceus-workbench: session listing failed: ${String(error)}`);
      cached = { rows: [], available: true };
      return cached;
    }
    cached = { rows, available: true };
    return cached;
  };
}

const PACKAGE_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Mount the workbench route; `version` is stamped into the JSON payload. */
export function apply(ctx: WorkbenchContext, config: WorkbenchConfig = {}, version = PACKAGE_VERSION): void {
  const limit = Math.max(1, Math.min(config.limit ?? 12, 50));
  const handler = createWorkbenchHandler({
    version,
    policy: policyReader(ctx),
    sessions: sessionReader(ctx, limit),
  });
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/caduceus', handler }),
    'caduceus: workbench route',
  );
}
