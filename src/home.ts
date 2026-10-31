/**
 * Path resolution for the directories dsh-caduceus reads and writes.
 *
 * Every consumer takes an explicit path or an injected environment object, so
 * unit tests never touch the real `~/.dsh`. Production code calls these helpers
 * with no arguments and therefore uses `os.homedir()` — never a shell-expanded
 * `~` (the file tools do not expand tildes).
 *
 * @module @artomyuan/dsh-caduceus/home
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The environment keys this package consults. All optional, like `process.env`. */
export interface HomeEnv {
  readonly DSH_HOME?: string | undefined;
  readonly DSH_AGENTS_HOME?: string | undefined;
  readonly HOME?: string | undefined;
  readonly USERPROFILE?: string | undefined;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** The OS user home, from `HOME`/`USERPROFILE`, falling back to `os.homedir()`. */
export function userHome(env: HomeEnv = process.env): string {
  return firstNonEmpty(env.HOME, env.USERPROFILE) ?? homedir();
}

/** `$DSH_HOME`, defaulting to `<user home>/.dsh`. Always absolute. */
export function dshHome(env: HomeEnv = process.env): string {
  return resolve(firstNonEmpty(env.DSH_HOME) ?? join(userHome(env), '.dsh'));
}

/**
 * `$DSH_AGENTS_HOME`, defaulting to `<DSH_HOME>/../.agents` (normally
 * `~/.agents`). This root is used by skill discovery, NOT by dsh's global
 * instruction loader (which reads `<DSH_HOME>/AGENTS.md`). Always absolute, so
 * a relative `DSH_HOME` cannot leak into the join.
 */
export function agentsHome(env: HomeEnv = process.env): string {
  return resolve(firstNonEmpty(env.DSH_AGENTS_HOME) ?? join(dshHome(env), '..', '.agents'));
}

/** `<DSH_HOME>/caduceus/session-map.json` (design doc §8). */
export function defaultSessionMapPath(env?: HomeEnv): string {
  return join(dshHome(env), 'caduceus', 'session-map.json');
}

/** Default SOUL source: `<DSH_HOME>/SOUL.md` (first candidate). */
export function defaultSoulPath(env?: HomeEnv): string {
  return join(dshHome(env), 'SOUL.md');
}

/**
 * SOUL source candidates, in priority order:
 * 1. `<DSH_HOME>/SOUL.md`, then
 * 2. `<DSH_AGENTS_HOME>/SOUL.md` (normally `~/.agents/SOUL.md`).
 *
 * The design allows the source to be absent; having a second conventional
 * location means a user who already keeps a SOUL file under the agents root
 * still works.
 */
export function defaultSoulCandidatePaths(env?: HomeEnv): readonly string[] {
  return [defaultSoulPath(env), join(agentsHome(env), 'SOUL.md')];
}

/** Default soul block target: `<DSH_HOME>/AGENTS.md` (what dsh actually reads). */
export function defaultAgentsFile(env?: HomeEnv): string {
  return join(dshHome(env), 'AGENTS.md');
}

/** Legacy target written by older caduceus builds: `<DSH_AGENTS_HOME>/AGENTS.md`. */
export function legacyAgentsFile(env?: HomeEnv): string {
  return join(agentsHome(env), 'AGENTS.md');
}

/** Default durable log file: `<DSH_HOME>/caduceus/caduceus.log`. */
export function defaultLogPath(env?: HomeEnv): string {
  return join(dshHome(env), 'caduceus', 'caduceus.log');
}
