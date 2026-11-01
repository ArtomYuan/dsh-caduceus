/**
 * Bridge seams: the structural agent/session/title interfaces the bridge needs.
 *
 * They are deliberately local (not imports of the concrete dsh classes) so unit
 * tests inject fakes and the gateway adapts `ctx.get('agents')` /
 * `ctx.get('sessionTitle')` at the edge. The real dsh objects satisfy these
 * shapes structurally.
 *
 * @module dsh-caduceus/bridge/types
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm';

import type { HarnessCommandResult } from '../commands/harness.js';
import type { LoggerLike } from '../logger.js';
import type { Clock } from '../render/stream.js';
import type { DoctorInputs, DoctorSessionInfo } from '../doctor.js';
import type { InteractiveRuntime } from '../interactive/runtime.js';
import type { SessionStore } from '../session-key.js';
import type { Transport } from '../transport/types.js';

/** Busy-turn delivery policy (design doc §6 L3). */
export type BusyMode = 'queue' | 'steer' | 'interrupt';

/** Session approval policy understood by dsh's approval service. */
export type ApprovalPolicy = 'ask' | 'never';

/** The slice of dsh's approval service the bridge needs. */
export interface ApprovalServiceLike {
  setPolicy(agent: AgentLike, policy: ApprovalPolicy): void;
}

/** Structural subset of a dsh session. */
export interface SessionLike {
  readonly id: string;
}

/** Structural subset of a live dsh agent. */
export interface AgentLike {
  readonly id: string;
  readonly session: SessionLike;
  followup(message: UserMessage): void;
  steer(message: UserMessage): void;
  cancel(cause: { kind: 'user' }): void;
}

/** Structural subset of `ctx.get('agents')` (`AgentRegistry`). */
export interface AgentsLike {
  get(sessionId: string): AgentLike | undefined;
  create(options: {
    readonly sessionId: string;
    /** dsh's own fields (cwd, agentPreset) plus caduceus ownership metadata. */
    readonly meta: {
      readonly cwd: string;
      readonly agentPreset?: string;
      readonly caduceus: {
        readonly chatId: string;
        readonly scopeKey: string;
        readonly kind: 'p2p' | 'topic' | 'group-user';
      };
    };
    /** Compose the unpublished agent scope (used to mount the preset). */
    readonly setup?: (agentCtx: unknown) => Promise<void> | void;
  }): Promise<{ readonly agent: AgentLike }>;
  resume(options: {
    readonly resumeSessionId: string;
    readonly setup?: (agentCtx: unknown) => Promise<void> | void;
  }): Promise<{ readonly agent: AgentLike }>;
}

/** Structural subset of `ctx.get('agentPresets')` (AgentPresetRegistry). */
export interface AgentPresetsLike {
  mount(agentCtx: unknown, id?: string): Promise<unknown>;
  composedPreset(agentCtx: unknown): string | undefined;
}

/** Structural subset of `ctx.get('sessionTitle')`. */
export interface SessionTitleLike {
  rename(session: unknown, title: string): unknown;
  get(session: unknown): { readonly title?: string } | undefined;
}

/** Normalized `/persona` outcome. */
export interface PersonaCommandResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** Resolved bridge configuration. */
export interface BridgeConfig {
  readonly defaultCwd: string;
  readonly allowedChats: readonly string[];
  readonly allowedUsers: readonly string[];
  readonly cardThrottleMs: number;
  readonly busyMode: BusyMode;
  /** Ordinary groups isolated per sender (Hermes default true); topics exempt. */
  readonly groupSessionsPerUser: boolean;
  /** Agent preset mounted for caduceus sessions (default `standard`). */
  readonly agentPreset?: string;
  /** Emoji reactions enabled (default true). */
  readonly reactions?: boolean;
  readonly reactionOnStart?: string;
  readonly reactionOnDone?: string;
  readonly reactionOnFail?: string;
}

/** Everything the bridge needs; unit tests provide fakes for every seam. */
export interface BridgeOptions {
  readonly transport: Transport;
  readonly sessionMap: SessionStore;
  readonly agents: AgentsLike;
  readonly config: BridgeConfig;
  readonly logger: LoggerLike;
  readonly clock?: Clock;
  /** Session-id minter; defaults to `feishu-<epoch-ms>` from session-key.ts. */
  readonly mintSessionId?: () => string;
  /** dsh command registry forwarding (unknown slash commands). */
  readonly runHarnessCommand?: (
    agent: AgentLike,
    line: string,
  ) => Promise<HarnessCommandResult | undefined>;
  /**
   * Title service seam (`/rename`, `/sessions`, `/status`). Resolved lazily on
   * every use because `ctx.get('sessionTitle')` can be undefined at apply time
   * (the service registers after the plugin mounts).
   */
  readonly sessionTitleProvider?: () => SessionTitleLike | undefined;
  /** Direct title service (tests); `sessionTitleProvider` takes precedence. */
  readonly sessionTitle?: SessionTitleLike;
  /** `/persona show|sync` handler shared with the persona entry. */
  readonly persona?: (action: 'show' | 'sync') => Promise<PersonaCommandResult>;
  /** Time source for elapsed rendering; defaults to the clock. */
  readonly now?: () => number;
  /** Interactive approval/question cards (wired by the gateway). */
  readonly interactive?: InteractiveRuntime;
  /** Plugin root Cordis context; answerers register here once, not per agent. */
  readonly rootCtx?: unknown;
  /** Lazily resolve dsh's approval service (agent-scoped setPolicy). */
  readonly approvalProvider?: () => ApprovalServiceLike | undefined;
  /** Desired session approval policy (default `ask`). */
  readonly approvalPolicy?: ApprovalPolicy;
  /** `/doctor` data collector (wired by the gateway; not available in tests by default). */
  readonly doctorInputs?: (
    session: DoctorSessionInfo,
  ) => DoctorInputs | Promise<DoctorInputs>;
  /** Optional self-check controller (`/status`, `/selfcheck`, stage B). */
  readonly selfCheck?: import('../selfcheck.js').SelfChecker;
  /** Owners sidecar directory (tests); defaults to `<DSH_HOME>/caduceus/owners`. */
  readonly ownershipDir?: string;
  /** Discover caduceus session ids on disk for `/adopt` (tests inject; default []). */
  readonly sessionIdsProvider?: () => readonly string[];
  /** Direct preset service (tests); `agentPresetsProvider` takes precedence. */
  readonly agentPresets?: AgentPresetsLike;
  /**
   * Lazy resolver: called on every create/resume until a service is found.
   * MUST NOT cache undefined — the service may register after plugin apply.
   */
  readonly agentPresetsProvider?: () => AgentPresetsLike | undefined;
  /** Persistent session-header preset lookup (undefined = legacy header). */
  readonly sessionPresetLookup?: (sessionId: string) => string | undefined;
  /**
   * True when a session id has a durable log on disk. Used by `/sessions` to
   * mark ghost entries `（未落地）`. Defaults to `() => true` (unknown = assume
   * landed); the gateway wires the real filesystem check.
   */
  readonly sessionExists?: (sessionId: string) => boolean;
}
