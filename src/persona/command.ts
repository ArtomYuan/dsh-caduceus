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
import type { LoggerLike } from '../logger.js';
import { readSoul, syncSoul, type SoulPaths } from './blocks.js';

export interface PersonaCommandOptions {
  readonly soulFile?: string;
  readonly agentsFile?: string;
  readonly env?: HomeEnv;
  readonly logger?: LoggerLike;
}

function pathsOf(options: PersonaCommandOptions): SoulPaths {
  return {
    ...(options.soulFile === undefined ? {} : { soulFile: options.soulFile }),
    ...(options.agentsFile === undefined ? {} : { agentsFile: options.agentsFile }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  };
}

function warningSuffix(warnings: readonly string[]): string {
  return warnings.length === 0 ? '' : `\n\n⚠️ ${warnings.join('\n⚠️ ')}`;
}

function targetSuffix(result: {
  readonly agentsFile: string;
  readonly agentsExists?: boolean;
  readonly legacyFile?: string;
}): string {
  const exists =
    result.agentsExists === true ? '存在' : result.agentsExists === false ? '不存在' : '未知';
  const legacy =
    result.legacyFile === undefined
      ? ''
      : `\n⚠️ 发现遗留块在 ${result.legacyFile}，可删（本插件不再写该位置）`;
  return `\n目标：${result.agentsFile}（${exists}）${legacy}`;
}

function bytesSuffix(result: {
  readonly status: string;
  readonly soulBytes: number;
  readonly agentsBytes: number;
}): string {
  return `\nstatus=${result.status} soulBytes=${result.soulBytes} agentsBytes=${result.agentsBytes}`;
}

/** Execute one `/persona` action. Never throws for file problems. */
export async function runPersonaCommand(
  action: 'show' | 'sync',
  options: PersonaCommandOptions = {},
): Promise<PersonaCommandResult> {
  const paths = pathsOf(options);

  if (action === 'sync') {
    const result = await syncSoul(paths);
    const where = `SOUL：${result.soulFile}${targetSuffix(result)}${bytesSuffix(result)}`;
    switch (result.status) {
      case 'created':
        return {
          kind: 'success',
          text: `已创建人格块（${result.soulBytes} 字节）。${where}${warningSuffix(result.warnings)}`,
        };
      case 'updated':
        return {
          kind: 'success',
          text: `已更新人格块（${result.soulBytes} 字节）。${where}${warningSuffix(result.warnings)}`,
        };
      case 'unchanged':
        return {
          kind: 'success',
          text: `人格块已是最新，未写盘。${where}${warningSuffix(result.warnings)}`,
        };
      case 'missing': {
        // Missing SOUL sources are a no-op by design (design doc §4): report it
        // plainly without creating any file and without an error status.
        const tried = result.tried === undefined ? '' : `（已尝试：${result.tried.join('、')}）`;
        return {
          kind: 'success',
          text: `未找到 SOUL 源${tried}，未改动 AGENTS.md。${where}
${result.reason ?? ''}`,
        };
      }
      case 'malformed':
        return {
          kind: 'error',
          text: `同步失败：目标文件中的人格标记不完整，未做改动。${where}\n${result.reason ?? ''}`,
        };
      case 'invalid':
        return {
          kind: 'error',
          text: `同步失败：${result.reason ?? 'SOUL 源含非法标记'}${where}`,
        };
    }
  }

  const shown = await readSoul(paths);
  switch (shown.status) {
    case 'present':
      return {
        kind: 'success',
        text: `当前人格块（${shown.soulBytes ?? 0} 字节）：\n\n${shown.content ?? ''}${targetSuffix(shown)}`,
      };
    case 'absent':
      return {
        kind: 'success',
        text: `AGENTS.md 里还没有人格块。发送 /persona sync 同步 SOUL.md。${targetSuffix(shown)}`,
      };
    case 'missing':
      return {
        kind: 'error',
        text: `读取失败：${shown.reason ?? 'AGENTS.md 不可读'}${targetSuffix(shown)}`,
      };
    case 'malformed':
      return {
        kind: 'error',
        text: `人格标记不完整（${shown.reason ?? '未知原因'}），为避免破坏文件未做任何改动。${targetSuffix(shown)}`,
      };
  }
}
