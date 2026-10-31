/**
 * Shared `/persona show|sync` behavior.
 *
 * Both the gateway (Feishu slash dispatch) and the `caduceus-persona` entry
 * (dsh command registry, Web parity) call this one implementation, so the two
 * surfaces can never drift.
 *
 * @module @artomyuan/dsh-caduceus/persona/command
 */
import type { PersonaCommandResult } from '../bridge/types.js';
import type { HomeEnv } from '../home.js';
import { readSoul, syncSoul, type SoulPaths } from './blocks.js';

export interface PersonaCommandOptions {
  readonly soulFile?: string;
  readonly agentsFile?: string;
  readonly env?: HomeEnv;
}

function pathsOf(options: PersonaCommandOptions): SoulPaths {
  return {
    ...(options.soulFile === undefined ? {} : { soulFile: options.soulFile }),
    ...(options.agentsFile === undefined ? {} : { agentsFile: options.agentsFile }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

function warningSuffix(warnings: readonly string[]): string {
  return warnings.length === 0 ? '' : `\n\n⚠️ ${warnings.join('\n⚠️ ')}`;
}

/** Execute one `/persona` action. Never throws for file problems. */
export async function runPersonaCommand(
  action: 'show' | 'sync',
  options: PersonaCommandOptions = {},
): Promise<PersonaCommandResult> {
  const paths = pathsOf(options);

  if (action === 'sync') {
    const result = await syncSoul(paths);
    const where = `SOUL：${result.soulFile}\n目标：${result.agentsFile}`;
    switch (result.status) {
      case 'created':
        return {
          kind: 'success',
          text: `已创建人格块（${result.soulBytes} 字节）。\n${where}${warningSuffix(result.warnings)}`,
        };
      case 'updated':
        return {
          kind: 'success',
          text: `已更新人格块（${result.soulBytes} 字节）。\n${where}${warningSuffix(result.warnings)}`,
        };
      case 'unchanged':
        return {
          kind: 'success',
          text: `人格块已是最新，未写盘。\n${where}${warningSuffix(result.warnings)}`,
        };
      case 'missing':
        return { kind: 'error', text: `同步失败：${result.reason ?? '源或目标文件不可用'}` };
      case 'malformed':
        return { kind: 'error', text: `同步失败：目标文件中的人格标记不完整，未做改动。\n${result.reason ?? ''}` };
      case 'invalid':
        return { kind: 'error', text: `同步失败：${result.reason ?? 'SOUL 源含非法标记'}` };
    }
  }

  const shown = await readSoul(paths);
  switch (shown.status) {
    case 'present':
      return {
        kind: 'success',
        text: `当前人格块（${shown.soulBytes ?? 0} 字节）：\n\n${shown.content ?? ''}`,
      };
    case 'absent':
      return {
        kind: 'success',
        text: `AGENTS.md 里还没有人格块。发送 /persona sync 同步 SOUL.md。\n目标：${shown.agentsFile}`,
      };
    case 'missing':
      return { kind: 'error', text: `读取失败：${shown.reason ?? 'AGENTS.md 不可读'}` };
    case 'malformed':
      return {
        kind: 'error',
        text: `人格标记不完整（${shown.reason ?? '未知原因'}），为避免破坏文件未做任何改动。`,
      };
  }
}
