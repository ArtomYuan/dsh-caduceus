/**
 * Bridge public surface.
 * @module dsh-caduceus/bridge
 */
export { Bridge, assistantTextFromEvent, progressCardForSnapshot, turnEndReasonKind } from './bridge.js';
export { ScopeQueue } from './scope-queue.js';
export type {
  AgentLike,
  AgentsLike,
  BridgeConfig,
  BridgeOptions,
  BusyMode,
  PersonaCommandResult,
  SessionLike,
  SessionTitleLike,
} from './types.js';
