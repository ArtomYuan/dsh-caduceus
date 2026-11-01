/**
 * Slash-command parsing for the Feishu surface. Pure: no I/O, no side effects.
 *
 * Eleven commands are owned by dsh-caduceus: `/new`, `/sessions`, `/rename`,
 * `/resume`, `/adopt`, `/stop`, `/status`, `/persona`, `/help`. Everything else — unknown slash
 * commands such as `/compact` and all ordinary user text — comes back as
 * `{ kind: 'passthrough', raw }` so the caller can forward it unchanged to the
 * dsh command registry or the agent (design doc §6 L3).
 *
 * @module dsh-caduceus/commands/parse
 */
import { stripLeadingMentions } from '../mentions.js';

/** Commands dsh-caduceus owns. Keep in sync with README's command table. */
export const COMMAND_NAMES = ['new', 'sessions', 'rename', 'resume', 'adopt', 'selfcheck', 'doctor', 'stop', 'status', 'persona', 'whoami', 'export', 'permission', 'help'] as const;

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
  { name: 'sessions', usage: '/sessions [--all]', description: '列出本会话；--all 列出同聊天下所有 scope 的会话' },
  { name: 'rename', usage: '/rename <标题>', description: '重命名当前会话的标题' },
  { name: 'resume', usage: '/resume [id|前缀]', description: '恢复上一条或按完整 id / 前缀（≥8 位）恢复会话' },
  { name: 'adopt', usage: '/adopt <id|尾号>', description: '把一条无归属的会话显式收养到当前 scope' },
  { name: 'selfcheck', usage: '/selfcheck', description: '立即重跑启动自检并输出明细' },
  { name: 'doctor', usage: '/doctor [--json]', description: '输出分段体检报告（文本或 JSON）' },
  { name: 'stop', usage: '/stop', description: '中断当前正在运行的一轮' },
  { name: 'status', usage: '/status', description: '显示本会话的运行状态、步数与起止时间' },
  { name: 'persona', usage: '/persona [show|sync]', description: '查看或同步 SOUL 人格块' },
  { name: 'whoami', usage: '/whoami', description: '显示你的 open_id、当前会话与身份' },
  { name: 'export', usage: '/export [--json]', description: '把当前会话导出为 markdown 或 JSONL 并发回文件' },
  { name: 'permission', usage: '/permission [档位]', description: '查看或切换当前会话的权限档位（中文）' },
  { name: 'help', usage: '/help', description: '显示命令表' },
];

export type PersonaAction = 'show' | 'sync';

export type ParsedCommand =
  | { readonly kind: 'new' }
  | { readonly kind: 'sessions'; readonly all?: boolean }
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'resume'; readonly sessionId?: string }
  | { readonly kind: 'adopt'; readonly sessionId: string }
  | { readonly kind: 'selfcheck' }
  | { readonly kind: 'doctor'; readonly json?: boolean }
  | { readonly kind: 'stop' }
  | { readonly kind: 'status' }
  | { readonly kind: 'persona'; readonly action: PersonaAction }
  | { readonly kind: 'whoami' }
  | { readonly kind: 'export'; readonly json?: boolean }
  | { readonly kind: 'permission'; readonly preset?: string }
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
  // A topic/group message may arrive as "@_user_1 /stop" (Feishu's mention
  // placeholder). Strip only the leading mentions before command detection;
  // passthrough still forwards the ORIGINAL bytes.
  const trimmed = stripLeadingMentions(raw).trim();
  if (!trimmed.startsWith('/')) return { kind: 'passthrough', raw };

  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) return { kind: 'passthrough', raw };

  const command = (match[1] as string).toLowerCase();
  const rest = (match[2] ?? '').trim();

  switch (command) {
    case 'new':
      return rest === '' ? { kind: 'new' } : usageResult('new', '/new 不接受参数');
    case 'sessions': {
      if (rest === '') return { kind: 'sessions' };
      if (rest.toLowerCase() === '--all') return { kind: 'sessions', all: true };
      return usageResult('sessions', '用法：/sessions [--all]');
    }
    case 'stop':
      return rest === '' ? { kind: 'stop' } : usageResult('stop', '/stop 不接受参数');
    case 'status':
      return rest === '' ? { kind: 'status' } : usageResult('status', '/status 不接受参数');
    case 'whoami':
      return rest === '' ? { kind: 'whoami' } : usageResult('whoami', '/whoami 不接受参数');
    case 'export': {
      if (rest === '') return { kind: 'export' };
      if (rest === '--json') return { kind: 'export', json: true };
      return usageResult('export', '用法：/export [--json]');
    }
    case 'permission': {
      if (rest === '') return { kind: 'permission' };
      const parts = rest.split(/\s+/);
      if (parts.length > 1) return usageResult('permission', '用法：/permission [档位]');
      return { kind: 'permission', preset: parts[0] as string };
    }
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
    case 'adopt': {
      if (rest === '') return usageResult('adopt', '用法：/adopt <id|尾号>');
      const parts = rest.split(/\s+/);
      if (parts.length > 1) return usageResult('adopt', '用法：/adopt <id|尾号>');
      return { kind: 'adopt', sessionId: parts[0] as string };
    }
    case 'selfcheck':
      return rest === '' ? { kind: 'selfcheck' } : usageResult('selfcheck', '/selfcheck 不接受参数');
    case 'doctor': {
      if (rest === '') return { kind: 'doctor' };
      if (rest === '--json') return { kind: 'doctor', json: true };
      return usageResult('doctor', '用法：/doctor [--json]');
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

/** dsh commands that already pass through the harness registry. */
export const DSH_NATIVE_COMMANDS: readonly { readonly name: string; readonly description: string }[] = [
  { name: 'compact', description: '压缩当前会话上下文' },
  { name: 'goal', description: '查看/管理当前目标' },
  { name: 'plan', description: '查看/切换计划模式' },
  { name: 'feedback', description: '提交反馈' },
];

/** The reply body for `/help`: owned commands plus dsh native passthroughs. */
export function helpText(): string {
  const lines = ['dsh-caduceus 命令：'];
  for (const spec of COMMAND_SPECS) lines.push(`${spec.usage} — ${spec.description}`);
  lines.push('', 'dsh 原生命令（透传）：');
  for (const command of DSH_NATIVE_COMMANDS) {
    lines.push(`/${command.name} — ${command.description}`);
  }
  lines.push('', '其他 /命令 与普通消息原样交给 dsh。');
  return lines.join('\n');
}
