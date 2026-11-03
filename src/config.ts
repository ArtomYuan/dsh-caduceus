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

import type { ApprovalPolicy, BridgeConfig, BusyMode } from './bridge/types.js';
import type { LangSetting } from './i18n.js';

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
  /** Send interactive approval cards (default true). */
  readonly approvalCard?: boolean;
  /** Send interactive question cards (default true). */
  readonly questionCard?: boolean;
  /** Interactive card timeout in ms (default 300000). */
  readonly interactiveTimeoutMs?: number;
  /** Session approval policy override; undefined keeps dsh's own policy. */
  readonly approvalPolicy?: ApprovalPolicy;
  /** Emoji reactions on inbound/turn-end (default true). */
  readonly reactions?: boolean;
  /** Emoji added on accept (default `OnIt`). */
  readonly reactionOnStart?: string;
  /** Emoji added on completed turn (default `DONE`). */
  readonly reactionOnDone?: string;
  /** Emoji added on failed/interrupted turn (default `CROSS_MARK`). */
  readonly reactionOnFail?: string;
  /** Require the bot's own open id for the group @ gate (default true). */
  readonly gateRequireBotIdentity?: boolean;
  /** Process image attachments (default true). */
  readonly images?: boolean;
  /** Process file attachments (default true). */
  readonly files?: boolean;
  /** Per-attachment byte cap (default 20 MiB). */
  readonly maxAttachmentBytes?: number;
  /** Send MEDIA:/path outputs back to Feishu (default true). */
  readonly sendMedia?: boolean;
  /** Outbound file size limit (default 30 MiB). */
  readonly maxSendFileBytes?: number;
  /** Outbound image size limit (default 10 MiB). */
  readonly maxSendImageBytes?: number;
  /** Allowed roots for MEDIA paths; empty = session cwd only. */
  readonly mediaRoots?: readonly string[];
  /** Admin open-id allowlist; empty disables access control (default). */
  readonly admins?: readonly string[];
  /** UI language: zh (default), en, or auto (settings/env, fallback zh). */
  readonly lang?: LangSetting;
  /** Export cache retention in hours (default 24). */
  readonly exportCacheMaxAgeHours?: number;
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
  approvalCard: z.boolean().required(false),
  questionCard: z.boolean().required(false),
  interactiveTimeoutMs: z.natural().min(1).required(false),
  approvalPolicy: z.union([z.const('ask'), z.const('never')]).required(false),
  reactions: z.boolean().required(false),
  reactionOnStart: z.string().required(false),
  reactionOnDone: z.string().required(false),
  reactionOnFail: z.string().required(false),
  gateRequireBotIdentity: z.boolean().required(false),
  images: z.boolean().required(false),
  files: z.boolean().required(false),
  maxAttachmentBytes: z.natural().min(1).required(false),
  sendMedia: z.boolean().required(false),
  maxSendFileBytes: z.natural().min(1).required(false),
  maxSendImageBytes: z.natural().min(1).required(false),
  mediaRoots: z.array(z.string()).required(false),
  admins: z.array(z.string()).required(false),
  lang: z.union([z.const('zh'), z.const('en'), z.const('auto')]).required(false),
  exportCacheMaxAgeHours: z.natural().min(1).required(false),
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

/** Default attachment switches/limit. */
export const DEFAULT_IMAGES = true;
export const DEFAULT_FILES = true;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Default outbound media switches/limits. */
export const DEFAULT_SEND_MEDIA = true;
export const DEFAULT_MAX_SEND_FILE_BYTES = 30 * 1024 * 1024;
export const DEFAULT_MAX_SEND_IMAGE_BYTES = 10 * 1024 * 1024;

/** Default message reactions. */
export const DEFAULT_REACTIONS = true;
export const DEFAULT_REACTION_ON_START = 'OnIt';
export const DEFAULT_REACTION_ON_DONE = 'DONE';
export const DEFAULT_REACTION_ON_FAIL = 'CROSS_MARK';

/** Default interactive-card switches/timeout. */
export const DEFAULT_APPROVAL_CARD = true;
export const DEFAULT_QUESTION_CARD = true;
export const DEFAULT_INTERACTIVE_TIMEOUT_MS = 300_000;

/**
 * Startup warning for access control (empty admin list = disabled).
 * Exported so the log line stays testable without mounting the plugin.
 */
export function accessControlWarning(admins: readonly string[]): string | undefined {
  return admins.length === 0 ? 'access control disabled (no admins configured)' : undefined;
}

export interface ResolvedGatewayConfig {
  readonly credentials?: {
    readonly appId: string;
    readonly appSecret: string;
  };
  readonly bridge: BridgeConfig;
  readonly logLevel: 'info' | 'debug';
  readonly personaAutoSync: boolean;
  readonly agentPreset: string;
  readonly approvalCard: boolean;
  readonly questionCard: boolean;
  readonly interactiveTimeoutMs: number;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly lang: LangSetting;
  readonly exportCacheMaxAgeHours: number;
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
    reactions: config.reactions ?? DEFAULT_REACTIONS,
    reactionOnStart: config.reactionOnStart ?? DEFAULT_REACTION_ON_START,
    reactionOnDone: config.reactionOnDone ?? DEFAULT_REACTION_ON_DONE,
    reactionOnFail: config.reactionOnFail ?? DEFAULT_REACTION_ON_FAIL,
    gateRequireBotIdentity: config.gateRequireBotIdentity ?? true,
    images: config.images ?? DEFAULT_IMAGES,
    files: config.files ?? DEFAULT_FILES,
    maxAttachmentBytes: config.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
    sendMedia: config.sendMedia ?? DEFAULT_SEND_MEDIA,
    maxSendFileBytes: config.maxSendFileBytes ?? DEFAULT_MAX_SEND_FILE_BYTES,
    maxSendImageBytes: config.maxSendImageBytes ?? DEFAULT_MAX_SEND_IMAGE_BYTES,
    mediaRoots: config.mediaRoots ?? [],
    admins: config.admins ?? [],
  };
  return {
    ...(appId === undefined || appSecret === undefined ? {} : { credentials: { appId, appSecret } }),
    bridge,
    logLevel: config.logLevel ?? DEFAULT_LOG_LEVEL,
    personaAutoSync: config.personaAutoSync ?? DEFAULT_PERSONA_AUTO_SYNC,
    agentPreset: config.agentPreset ?? DEFAULT_AGENT_PRESET,
    approvalCard: config.approvalCard ?? DEFAULT_APPROVAL_CARD,
    questionCard: config.questionCard ?? DEFAULT_QUESTION_CARD,
    interactiveTimeoutMs: config.interactiveTimeoutMs ?? DEFAULT_INTERACTIVE_TIMEOUT_MS,
    ...(config.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: config.approvalPolicy }),
    lang: config.lang ?? 'zh',
    exportCacheMaxAgeHours: config.exportCacheMaxAgeHours ?? 24,
  };
}
