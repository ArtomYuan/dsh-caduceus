/**
 * Slash-command parsing for the Feishu surface. Pure: no I/O, no side effects.
 *
 * Eight commands are owned by dsh-caduceus: `/new`, `/sessions`, `/rename`,
 * `/resume`, `/stop`, `/status`, `/persona`, `/help`. Everything else — unknown slash
 * commands such as `/compact` and all ordinary user text — comes back as
 * `{ kind: 'passthrough', raw }` so the caller can forward it unchanged to the
 * dsh command registry or the agent (design doc §6 L3).
 *
 * @module @artomyuan/dsh-caduceus/commands/parse
 */

/** Commands dsh-caduceus owns. Keep in sync with README's command table. */
export const COMMAND_NAMES = ['new', 'sessions', 'rename', 'resume', 'stop', 'status', 'persona', 'help'] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CommandSpec {
  readonly name: CommandName;
  /** Short usage line, e.g. `/rename <标题>`. */
  readonly usage: string;
  readonly description: string;
}

/** Command metadata; `helpText()` and the README command table both derive from it. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: 'new', usage: '/new', description: '为当前聊天/话题新建会话，旧会话保留' },
  { name: 'sessions', usage: '/sessions', description: '列出本聊天/话题的会话与标题' },
  { name: 'rename', usage: '/rename <标题>', description: '重命名当前会话的标题' },
  { name: 'resume', usage: '/resume [id]', description: '恢复本聊天/话题的上一条或指定会话' },
  { name: 'stop', usage: '/stop', description: '中断当前正在运行的一轮' },
  { name: 'status', usage: '/status', description: '显示本会话的运行状态、步数与起止时间' },
  { name: 'persona', usage: '/persona [show|sync]', description: '查看或同步 SOUL 人格块' },
  { name: 'help', usage: '/help', description: '显示命令表' },
];

export type PersonaAction = 'show' | 'sync';

export type ParsedCommand =
  | { readonly kind: 'new' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'resume'; readonly sessionId?: string }
  | { readonly kind: 'stop' }
  | { readonly kind: 'status' }
  | { readonly kind: 'persona'; readonly action: PersonaAction }
  | { readonly kind: 'help' }
  | { readonly kind: 'usage'; readonly command: string; readonly usage: string; readonly reason: string }
  | { readonly kind: 'passthrough'; readonly raw: string };

function usageResult(command: CommandName, reason: string): ParsedCommand {
  const spec = COMMAND_SPECS.find((candidate) => candidate.name === command);
  return { kind: 'usage', command, usage: spec?.usage ?? `/${command}`, reason };
}

/**
 * Parse one inbound message.
 *
 * Leading/trailing whitespace is ignored for recognised commands, but
 * `passthrough.raw` is always the original input, byte for byte, so forwarding
 * never rewrites a user's text.
 */
export function parseCommand(raw: string): ParsedCommand {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return { kind: 'passthrough', raw };

  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return { kind: 'passthrough', raw };

  const command = (match[1] as string).toLowerCase();
  const rest = (match[2] ?? '').trim();

  switch (command) {
    case 'new':
      return rest === '' ? { kind: 'new' } : usageResult('new', '/new 不接受参数');
    case 'sessions':
      return rest === '' ? { kind: 'sessions' } : usageResult('sessions', '/sessions 不接受参数');
    case 'stop':
      return rest === '' ? { kind: 'stop' } : usageResult('stop', '/stop 不接受参数');
    case 'status':
      return rest === '' ? { kind: 'status' } : usageResult('status', '/status 不接受参数');
    case 'help':
      return { kind: 'help' };
    case 'rename':
      return rest === '' ? usageResult('rename', '用法：/rename <标题>') : { kind: 'rename', title: rest };
    case 'resume': {
      if (rest === '') return { kind: 'resume' };
      const parts = rest.split(/\s+/);
      if (parts.length > 1) return usageResult('resume', '用法：/resume [id]');
      return { kind: 'resume', sessionId: parts[0] as string };
    }
    case 'persona': {
      if (rest === '') return { kind: 'persona', action: 'show' };
      const action = rest.toLowerCase();
      if (action === 'show' || action === 'sync') return { kind: 'persona', action };
      return usageResult('persona', '用法：/persona [show|sync]');
    }
    default:
      // Unknown slash command (e.g. /compact): let the dsh command registry try it.
      return { kind: 'passthrough', raw };
  }
}

/** The reply body for `/help`, one line per owned command. */
export function helpText(): string {
  const lines = ['dsh-caduceus 命令：'];
  for (const spec of COMMAND_SPECS) lines.push(`${spec.usage} — ${spec.description}`);
  lines.push('其他 /命令 与普通消息原样交给 dsh。');
  return lines.join('\n');
}
