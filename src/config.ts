/**
 * Gateway configuration (design doc §10) and the schemastery schema the dsh
 * profile validates entries with.
 *
 * Credentials may come from the profile config or from `FEISHU_APP_ID` /
 * `FEISHU_APP_SECRET`; without them the gateway mounts in "idle" mode (ready
 * log, no long connection), which keeps a fresh profile bootable.
 *
 * @module dsh-caduceus/config
 */
import { resolve } from 'node:path';

import z from '@deepseek-ai/schemastery';

import type { BridgeConfig, BusyMode } from './bridge/types.js';

/** Raw entry config as written in the profile. */
export interface GatewayConfig {
  readonly appId?: string;
  readonly appSecret?: string;
  readonly defaultCwd?: string;
  readonly allowedChats?: readonly string[];
  readonly allowedUsers?: readonly string[];
  readonly cardThrottleMs?: number;
  readonly busyMode?: BusyMode;
  /** Ordinary groups isolated per sender (Hermes default true); topics exempt. */
  readonly groupSessionsPerUser?: boolean;
  /** File-log verbosity: `info` (default) or `debug`. */
  readonly logLevel?: 'info' | 'debug';
  /** Auto-sync SOUL into `<DSH_HOME>/AGENTS.md` on startup (default true). */
  readonly personaAutoSync?: boolean;
  /** Agent preset mounted for caduceus-created sessions (default `standard`). */
  readonly agentPreset?: string;
}

/** Schemastery schema for the `caduceus-gateway` entry. */
export const Config = z.object({
  appId: z.string().required(false),
  appSecret: z.string().required(false),
  defaultCwd: z.string().required(false),
  allowedChats: z.array(z.string()).required(false),
  allowedUsers: z.array(z.string()).required(false),
  cardThrottleMs: z.natural().min(1).required(false),
  busyMode: z.union([z.const('queue'), z.const('steer'), z.const('interrupt')]).required(false),
  groupSessionsPerUser: z.boolean().required(false),
  logLevel: z.union([z.const('info'), z.const('debug')]).required(false),
  personaAutoSync: z.boolean().required(false),
  agentPreset: z.string().required(false),
});

/** Default card patch throttle: half of Feishu's 5 QPS budget. */
export const DEFAULT_CARD_THROTTLE_MS = 400;

/** Default busy policy: queue the message for the next turn. */
export const DEFAULT_BUSY_MODE: BusyMode = 'queue';

/** Default ordinary-group isolation: per sender (Hermes default). */
export const DEFAULT_GROUP_SESSIONS_PER_USER = true;

/** Default file-log verbosity. */
export const DEFAULT_LOG_LEVEL: 'info' | 'debug' = 'info';

/** Default: sync the persona block on startup so it never drifts. */
export const DEFAULT_PERSONA_AUTO_SYNC = true;

/** Default agent preset for caduceus sessions. */
export const DEFAULT_AGENT_PRESET = 'standard';

export interface ResolvedGatewayConfig {
  readonly credentials?: {
    readonly appId: string;
    readonly appSecret: string;
  };
  readonly bridge: BridgeConfig;
  readonly logLevel: 'info' | 'debug';
  readonly personaAutoSync: boolean;
  readonly agentPreset: string;
}

export interface ConfigEnv {
  readonly FEISHU_APP_ID?: string;
  readonly FEISHU_APP_SECRET?: string;
  readonly DSH_CADUCEUS_DEFAULT_CWD?: string;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Merge raw config with environment defaults.
 *
 * @param config - validated entry config.
 * @param env - environment snapshot (injectable for tests).
 * @param cwd - process cwd fallback for `defaultCwd`.
 */
export function resolveGatewayConfig(
  config: GatewayConfig = {},
  env: ConfigEnv = process.env,
  cwd: string = process.cwd(),
): ResolvedGatewayConfig {
  const appId = firstNonEmpty(config.appId, env.FEISHU_APP_ID);
  const appSecret = firstNonEmpty(config.appSecret, env.FEISHU_APP_SECRET);
  const bridge: BridgeConfig = {
    defaultCwd: resolve(firstNonEmpty(config.defaultCwd, env.DSH_CADUCEUS_DEFAULT_CWD) ?? cwd),
    allowedChats: config.allowedChats ?? [],
    allowedUsers: config.allowedUsers ?? [],
    cardThrottleMs: config.cardThrottleMs ?? DEFAULT_CARD_THROTTLE_MS,
    busyMode: config.busyMode ?? DEFAULT_BUSY_MODE,
    groupSessionsPerUser:
      config.groupSessionsPerUser ?? DEFAULT_GROUP_SESSIONS_PER_USER,
    agentPreset: config.agentPreset ?? DEFAULT_AGENT_PRESET,
  };
  return {
    ...(appId === undefined || appSecret === undefined ? {} : { credentials: { appId, appSecret } }),
    bridge,
    logLevel: config.logLevel ?? DEFAULT_LOG_LEVEL,
    personaAutoSync: config.personaAutoSync ?? DEFAULT_PERSONA_AUTO_SYNC,
    agentPreset: config.agentPreset ?? DEFAULT_AGENT_PRESET,
  };
}
