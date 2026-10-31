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

import { Bridge } from './bridge/bridge.js';
import type { AgentLike, AgentsLike, SessionTitleLike } from './bridge/types.js';
import { runHarnessCommand } from './commands/harness.js';
import { Config, resolveGatewayConfig, type GatewayConfig } from './config.js';
import { adaptLogger, type LoggerLike } from './logger.js';
import { runPersonaCommand } from './persona/command.js';
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
  const logger: LoggerLike = adaptLogger(ctx.logger('caduceus'));
  logger.info('caduceus-gateway ready');

  const resolved = resolveGatewayConfig(config);
  logger.info(`groupSessionsPerUser=${resolved.bridge.groupSessionsPerUser}`);
  if (resolved.credentials === undefined) {
    logger.warn(
      'feishu credentials missing (appId/appSecret or FEISHU_APP_ID/FEISHU_APP_SECRET); long connection not started',
    );
    return;
  }

  const sessionMap = new SessionStore();
  sessionMap.load();
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
    sessionTitle: ctx.get('sessionTitle') as SessionTitleLike | undefined,
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
    void transport.start().catch((error: unknown) => {
      logger.error(`feishu long connection failed to start: ${errorText(error)}`);
    });
    return () => {
      void transport.stop().catch((error: unknown) => {
        logger.warn(`feishu long connection failed to stop: ${errorText(error)}`);
      });
    };
  });
}
