/**
 * Adapter from the dsh command registry (`ctx.get('commands')`) to the small
 * result shape the bridge renders.
 *
 * `commands.execute` resolves `undefined` when the line is not a known command,
 * which is exactly the signal the bridge needs to fall back to "unknown
 * command". Handler errors are contained here: one bad command must not take
 * the surface down.
 *
 * @module dsh-caduceus/commands/harness
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandRuntime } from '@deepseek-ai/dsh-commands';

/** Normalized harness-command outcome. */
export interface HarnessCommandResult {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/**
 * Execute one slash line through the dsh command registry.
 *
 * @param commands - the registry service, or `undefined` when dsh did not mount it.
 * @param agent - the live agent the command runs against.
 * @param line - the complete slash line (forwarded byte for byte).
 * @returns the normalized result, or `undefined` when no command matched.
 */
export async function runHarnessCommand(
  commands: CommandRuntime | undefined,
  agent: Agent,
  line: string,
): Promise<HarnessCommandResult | undefined> {
  if (commands === undefined || typeof commands.execute !== 'function') return undefined;
  try {
    const execution = await commands.execute(agent, line, [], new AbortController().signal);
    if (execution === undefined) return undefined;
    const { result } = execution;
    return {
      kind: result.kind,
      text: result.kind === 'success' ? (result.text ?? '') : result.text,
    };
  } catch {
    return undefined;
  }
}
