/**
 * `caduceus-persona` cordis entry — the bundle row `caduceus-persona` in
 * `cordis.patch.yml`.
 *
 * It registers the canonical `/persona` command in the dsh command registry
 * (Web parity). The Feishu gateway dispatches `/persona` itself through the
 * same {@link runPersonaCommand}, so both surfaces behave identically.
 *
 * @module @artomyuan/dsh-caduceus/persona
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandDefinition, CommandRuntime } from '@deepseek-ai/dsh-commands';
import z from '@deepseek-ai/schemastery';

import { adaptLogger } from '../logger.js';
import { runPersonaCommand } from './command.js';

/** Stable cordis plugin name; must match the bundle row id. */
export const name = 'caduceus-persona';

/** Optional explicit file overrides (defaults follow `$DSH_HOME` / `$DSH_AGENTS_HOME`). */
export interface Config {
  readonly soulFile?: string;
  readonly agentsFile?: string;
}

export const Config = z.object({
  soulFile: z.string().required(false),
  agentsFile: z.string().required(false),
});

/** Mount the persona entry. */
export function apply(ctx: Context, config: Config = {}): void {
  const logger = ctx.logger('caduceus-persona');
  logger.info('caduceus-persona ready');

  const commands = ctx.get('commands') as CommandRuntime | undefined;
  if (commands === undefined) {
    logger.warn('commands service unavailable; /persona is only reachable from Feishu');
    return;
  }

  const options = {
    ...(config.soulFile === undefined ? {} : { soulFile: config.soulFile }),
    ...(config.agentsFile === undefined ? {} : { agentsFile: config.agentsFile }),
  };

  const definition: CommandDefinition = {
    name: 'persona',
    description: '查看或同步 SOUL 人格块',
    input: { hint: 'show | sync' },
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim().toLowerCase();
      const action = raw === 'sync' ? 'sync' : raw === '' || raw === 'show' ? 'show' : undefined;
      if (action === undefined) return { kind: 'error', text: '用法：/persona [show|sync]' };
      return runPersonaCommand(action, { ...options, logger: adaptLogger(logger) });
    },
  };
  commands.register(definition);
}
