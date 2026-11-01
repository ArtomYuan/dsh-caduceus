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
 * @module dsh-caduceus
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';

import { backfillSessionOwnership, scanSessionDirs } from './backfill.js';
import { Bridge } from './bridge/bridge.js';
import type {
  ApprovalServiceLike,
  AttachmentStoreLike,
  PermissionPresetsLike,
} from './bridge/types.js';
import type {
  AgentLike,
  AgentPresetsLike,
  AgentsLike,
  SessionTitleLike,
} from './bridge/types.js';
import { runHarnessCommand } from './commands/harness.js';
import { parseSessionEvents } from './export.js';
import {
  Config,
  accessControlWarning,
  resolveGatewayConfig,
  type GatewayConfig,
} from './config.js';
import { FileLogger } from './file-logger.js';
import { defaultLogPath } from './home.js';
import { adaptLogger, teeLoggers, type LoggerLike } from './logger.js';
import { formatStartupLine } from './observability.js';
import { autoSyncPersona } from './persona/auto-sync.js';
import { runPersonaCommand } from './persona/command.js';
import { InteractiveRuntime } from './interactive/runtime.js';
import { SelfChecker } from './selfcheck.js';
import { hasSessionLog } from './session-files.js';
import { SESSION_MAP_VERSION, SessionStore } from './session-key.js';
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

interface SessionsServiceLike {
  get(sessionId: string):
    | { readonly header?: { readonly agentPreset?: string } }
    | undefined;
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
    create: async ({ sessionId, meta, setup }) => {
      const agents = service();
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot create a session');
      }
      return agents.create({
        sessionId,
        meta,
        ...(setup === undefined ? {} : { setup }),
        ...agentOptions(ctx),
      });
    },
    resume: async ({ resumeSessionId, setup }) => {
      const agents = service();
      if (agents === undefined) {
        throw new Error('agents service unavailable; cannot resume a session');
      }
      return agents.resume({
        resumeSessionId,
        ...(setup === undefined ? {} : { setup }),
        ...agentOptions(ctx),
      });
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageVersionOf(specifier: string, fallback: string): string {
  try {
    const raw = readFileSync(specifier, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : fallback;
  } catch {
    return fallback;
  }
}

/** Plugin version from this package's package.json (works from dist/). */
function pluginVersion(): string {
  return packageVersionOf(new URL('../package.json', import.meta.url).pathname, 'unknown');
}

/** dsh version from the installed @deepseek-ai/dsh package. */
function dshVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return packageVersionOf(require.resolve('@deepseek-ai/dsh/package.json'), 'unknown');
  } catch {
    return 'unknown';
  }
}

function hasService(ctx: Context, name: string): boolean {
  try {
    return ctx.get(name as never) !== undefined;
  } catch {
    return false;
  }
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
  logger.info(`agent preset=${resolved.agentPreset}`);
  if (resolved.approvalPolicy !== undefined) {
    logger.info(`approval policy override=${resolved.approvalPolicy}`);
  }
  const accessWarning = accessControlWarning(resolved.bridge.admins ?? []);
  if (accessWarning !== undefined) logger.warn(accessWarning);
  const selfCheck = new SelfChecker({
    logger,
    getAgentPresets: () => ctx.get('agentPresets') as AgentPresetsLike | undefined,
    getTools: () => ctx.get('tools'),
  });
  const sessionMap = new SessionStore();
  sessionMap.load();
  // Ownership backfill is read-only for dsh sessions (session-map writes only),
  // and must run even in idle/no-credential mode so old sessions stay reachable.
  backfillSessionOwnership(sessionMap, { logger });
  const personaAutoSync = (): Promise<void> =>
    autoSyncPersona({ enabled: resolved.personaAutoSync, logger });
  // Stage A is non-blocking: startup never waits for the self-check.
  void selfCheck.runStageA();

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
  let bridge!: Bridge;
  const interactive = new InteractiveRuntime({
    config: {
      approvalCard: resolved.approvalCard,
      questionCard: resolved.questionCard,
      timeoutMs: resolved.interactiveTimeoutMs,
    },
    logger,
    sendCard: (sessionId, card) => bridge.sendInteractiveCard(sessionId, card),
    updateCard: (messageId, card) => transport.updateCard(messageId, card),
  });
  transport.onCardAction?.((action) => {
    void interactive.handleCardAction(action);
  });

  bridge = new Bridge({
    transport,
    sessionMap,
    agents: makeAgents(ctx),
    config: resolved.bridge,
    logger,
    sessionExists: (sessionId) => hasSessionLog(sessionId),
    sessionIdsProvider: () => scanSessionDirs().map((entry) => entry.sessionId),
    // Lazy per use: the preset registry can register AFTER this plugin mounts.
    agentPresetsProvider: () => ctx.get('agentPresets') as AgentPresetsLike | undefined,
    selfCheck,
    interactive,
    rootCtx: ctx,
    approvalProvider: () => ctx.get('approval') as ApprovalServiceLike | undefined,
    attachmentProvider: () => ctx.get('attachments') as AttachmentStoreLike | undefined,
    permissionPresetsProvider: () =>
      ctx.get('permissionPresets') as PermissionPresetsLike | undefined,
    exportProvider: async (sessionId) => {
      const query = ctx.get('sessionQuery') as
        | { readSession?: (id: string) => Promise<{ events?: readonly unknown[] }> }
        | undefined;
      if (query?.readSession === undefined) return undefined;
      try {
        const snapshot = await query.readSession(sessionId);
        const events = snapshot.events ?? [];
        return {
          messages: parseSessionEvents(events),
          rawJsonl: events.map((event) => JSON.stringify(event)).join('\n') + '\n',
        };
      } catch {
        return undefined;
      }
    },
    approvalPolicy: resolved.approvalPolicy,
    sessionPresetLookup: (sessionId) =>
      (ctx.get('sessions') as SessionsServiceLike | undefined)?.get(sessionId)?.header
        ?.agentPreset,
    doctorInputs: (session) => {
      let mapWritable: boolean;
      try {
        const dir = dirname(sessionMap.filePath);
        mkdirSync(dir, { recursive: true });
        const probe = join(dir, '.doctor-write-probe');
        writeFileSync(probe, 'ok', 'utf8');
        rmSync(probe, { force: true });
        mapWritable = true;
      } catch {
        mapWritable = false;
      }
      const connection = transport.getConnectionStatus?.();
      const delivery = transport.getDeliveryStats?.();
      return {
        versions: { plugin: pluginVersion(), dsh: dshVersion(), node: process.version },
        runtime: {
          ...(session.preset === undefined ? {} : { preset: session.preset }),
          ...(session.presetMounted === undefined
            ? {}
            : { presetMounted: session.presetMounted }),
          ...(session.toolsCount === undefined ? {} : { toolsCount: session.toolsCount }),
          sessionTitleService: hasService(ctx, 'sessionTitle'),
          agentsService: hasService(ctx, 'agents'),
        },
        feishu: {
          ...(resolved.credentials === undefined ? {} : { appId: resolved.credentials.appId }),
          ...(transport.getBotName?.() === undefined
            ? {}
            : { botName: transport.getBotName?.(),
              }),
          connectionReady: connection?.ready,
          ...(connection?.since === undefined ? {} : { connectedSince: connection.since }),
          ...(delivery?.lastSuccessAt === undefined
            ? {}
            : { lastSendAt: delivery.lastSuccessAt }),
          ...(delivery?.lastKind === undefined ? {} : { lastSendKind: delivery.lastKind }),
          ...(delivery?.failures === undefined ? {} : { sendFailures: delivery.failures }),
        },
        persona: { env: process.env },
        session,
        storage: {
          mapVersion: SESSION_MAP_VERSION,
          mapWritable,
          mapEntries: Object.keys(sessionMap.snapshot().entries).length,
        },
      };
    },
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
