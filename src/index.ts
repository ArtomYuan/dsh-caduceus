/**
 * `caduceus-gateway` cordis entry — the bundle row `caduceus-gateway` in
 * `cordis.patch.yml`.
 *
 * Wiring only: resolve config/credentials, build the real transport, adapt the
 * dsh services (`agents`, `sessionTitle`, `commands`, `agentDefaultModel`),
 * subscribe to `session/event`, and mount the bridge. All logic lives in the
 * tested modules; this file is the seam to the dsh runtime and therefore has no
 * unit tests (its adapters are validated on a real profile in docs/SLICE2.md).
 *
 * @module @artomyuan/dsh-caduceus
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';

import { backfillSessionOwnership, scanSessionDirs } from './backfill.js';
import { Bridge } from './bridge/bridge.js';
import type { AgentLike, AgentsLike, SessionTitleLike } from './bridge/types.js';
import { runHarnessCommand } from './commands/harness.js';
import { Config, resolveGatewayConfig, type GatewayConfig } from './config.js';
import { FileLogger } from './file-logger.js';
import { defaultLogPath } from './home.js';
import { adaptLogger, teeLoggers, type LoggerLike } from './logger.js';
import { formatStartupLine } from './observability.js';
import { autoSyncPersona } from './persona/auto-sync.js';
import { runPersonaCommand } from './persona/command.js';
import { hasSessionLog } from './session-files.js';
import { SessionStore } from './session-key.js';
import { createLarkFeishuApi } from './transport/lark.js';
import { ReliableTransport } from './transport/reliable.js';

export { Config };
export type { GatewayConfig };

/** Stable cordis plugin name; must match the bundle row id. */
export const name = 'caduceus-gateway';

interface AgentsServiceLike {
  get(sessionId: string): AgentLike | undefined;
  create(options: Record<string, unknown>): Promise<{ readonly agent: AgentLike }>;
  resume(options: Record<string, unknown>): Promise<{ readonly agent: AgentLike }>;
}

interface AgentDefaultModelLike {
  currentSelection?(): {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  };
}

function agentOptions(ctx: Context): Record<string, unknown> {
  try {
    const service = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined;
    const selection = service?.currentSelection?.();
    if (selection === undefined) return {};
    return {
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      },
    };
  } catch {
    return {};
  }
}

/** Adapt `ctx.get('agents')` to the bridge's structural seam. */
function makeAgents(ctx: Context): AgentsLike {
  const service = (): AgentsServiceLike | undefined =>
    ctx.get('agents') as AgentsServiceLike | undefined;
  return {
    get: (sessionId) => service()?.get(sessionId),
    create: async ({ sessionId, meta }) => {
      const agents = service();
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot create a session');
      }
      return agents.create({ sessionId, meta, ...agentOptions(ctx) });
    },
    resume: async ({ resumeSessionId }) => {
      const agents = service();
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot resume a session');
      }
      return agents.resume({ resumeSessionId, ...agentOptions(ctx) });
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mount the gateway entry. */
export function apply(ctx: Context, config: GatewayConfig = {}): void {
  const resolved = resolveGatewayConfig(config);

  // Visible diagnostics: the file log is written unconditionally (ctx.logger
  // lines did not reach the journal on the real deployment).
  const consoleLogger: LoggerLike = adaptLogger(ctx.logger('caduceus'));
  const fileLogger = new FileLogger({
    filePath: defaultLogPath(),
    level: resolved.logLevel,
  });
  const logger: LoggerLike = teeLoggers(consoleLogger, fileLogger);
  logger.info(
    formatStartupLine({
      ...(resolved.credentials === undefined ? {} : { appId: resolved.credentials.appId }),
      // Passed only so the formatter can be tested to never print it.
      ...(resolved.credentials === undefined
        ? {}
        : { appSecret: resolved.credentials.appSecret }),
      defaultCwd: resolved.bridge.defaultCwd,
      groupSessionsPerUser: resolved.bridge.groupSessionsPerUser,
      cardThrottleMs: resolved.bridge.cardThrottleMs,
      busyMode: resolved.bridge.busyMode,
    }),
  );
  const sessionMap = new SessionStore();
  sessionMap.load();
  // Ownership backfill is read-only for dsh sessions (session-map writes only),
  // and must run even in idle/no-credential mode so old sessions stay reachable.
  backfillSessionOwnership(sessionMap, { logger });
  const personaAutoSync = (): Promise<void> =>
    autoSyncPersona({ enabled: resolved.personaAutoSync, logger });

  if (resolved.credentials === undefined) {
    // Still keep the projection fresh in idle/no-credentials mode.
    void personaAutoSync();
    logger.warn(
      'feishu credentials missing (appId/appSecret or FEISHU_APP_ID/FEISHU_APP_SECRET); long connection not started',
    );
    return;
  }
  const api = createLarkFeishuApi({
    appId: resolved.credentials.appId,
    appSecret: resolved.credentials.appSecret,
    logger,
  });
  const transport = new ReliableTransport(api, { logger });

  const bridge = new Bridge({
    transport,
    sessionMap,
    agents: makeAgents(ctx),
    config: resolved.bridge,
    logger,
    sessionExists: (sessionId) => hasSessionLog(sessionId),
    sessionIdsProvider: () => scanSessionDirs().map((entry) => entry.sessionId),
    // Lazy per use: the service can register AFTER this plugin mounts.
    sessionTitleProvider: () => ctx.get('sessionTitle') as SessionTitleLike | undefined,
    persona: (action) => runPersonaCommand(action, { logger }),
    runHarnessCommand: async (agent, line) => {
      const commands = ctx.get('commands') as CommandRuntime | undefined;
      return runHarnessCommand(commands, agent as unknown as Agent, line);
    },
  });

  transport.onMessage((message) => {
    void bridge.handleInbound(message).catch((error: unknown) => {
      logger.error(`inbound message failed: ${errorText(error)}`);
    });
  });

  ctx.on('session/event', (session, event: SessionEvent) => {
    const sessionId = String(session.id);
    if (!bridge.ownsSession(sessionId)) return;
    void bridge.handleSessionEvent(session, event).catch((error: unknown) => {
      logger.error(`session event handling failed: ${errorText(error)}`);
    });
  });

  ctx.effect(() => {
    void (async () => {
      // Persona sync completes before the long connection starts, so it is
      // always ahead of the first inbound message.
      await personaAutoSync();
      await transport.start();
    })().catch((error: unknown) => {
      logger.error(`feishu long connection failed to start: ${errorText(error)}`);
    });
    return () => {
      void transport.stop().catch((error: unknown) => {
        logger.warn(`feishu long connection failed to stop: ${errorText(error)}`);
      });
    };
  });
}
