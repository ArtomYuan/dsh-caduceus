/**
 * `/export`: render one dsh session as markdown (or raw JSONL) for Feishu.
 *
 * The Web UI exports ZIPs with a browser-side download; IM must do its own
 * rendering, so this module reads the session log (provided by a service seam or
 * the on-disk JSONL/Zstd log) and writes a bounded local file that the MEDIA
 * chain can send.
 *
 * @module dsh-caduceus/export
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export type ExportRole = 'user' | 'assistant' | 'tool';

export interface ExportMessage {
  readonly role: ExportRole;
  readonly text: string;
  readonly toolName?: string;
}

export interface SessionExportData {
  readonly messages: readonly ExportMessage[];
  /** Original uncompressed JSONL when available. */
  readonly rawJsonl?: string;
}

export type SessionExportProvider = (
  sessionId: string,
) => SessionExportData | undefined | Promise<SessionExportData | undefined>;

export const EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const TRUNCATED_MARKER = '\n\n> 导出内容超过 5MB，已截断。\n';

export function truncateExport(text: string): string {
  return truncateUtf8(text, TRUNCATED_MARKER);
}

function truncateUtf8(text: string, marker: string): string {
  if (Buffer.byteLength(text, 'utf8') <= EXPORT_MAX_BYTES) return text;
  const budget = EXPORT_MAX_BYTES - Buffer.byteLength(marker, 'utf8');
  return Buffer.from(text, 'utf8').subarray(0, Math.max(0, budget)).toString('utf8') + marker;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('\n');
}

export function parseSessionEvents(events: readonly unknown[]): ExportMessage[] {
  return messagesFromJsonl(events.map((event) => JSON.stringify(event)).join('\n'));
}

function messagesFromJsonl(raw: string): ExportMessage[] {
  const messages: ExportMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { type?: unknown; data?: unknown };
    const type = typeof record.type === 'string' ? record.type : '';
    const data = (record.data ?? {}) as Record<string, unknown>;
    const message = (data['message'] ?? {}) as Record<string, unknown>;
    const text = textFromContent(message['content'] ?? data['content']);
    if (text.length === 0) continue;
    if (type === 'user/message') {
      messages.push({ role: 'user', text });
    } else if (type === 'assistant/message') {
      messages.push({ role: 'assistant', text });
    } else if (type === 'tool/result') {
      const toolName =
        (typeof data['toolName'] === 'string' && data['toolName']) ||
        (typeof data['name'] === 'string' && data['name']) ||
        (typeof message['name'] === 'string' && message['name']) ||
        'tool';
      messages.push({ role: 'tool', toolName, text });
    }
  }
  return messages;
}

/** Locate the newest `session[.vN].jsonl[.zstd]` belonging to one session. */
export function findSessionLog(sessionId: string, dshHome: string): string | undefined {
  const root = join(dshHome, 'sessions');
  const candidates: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!/^session(?:\.[^/]+)?\.jsonl(?:\.zstd)?$/.test(entry.name)) continue;
      if (!path.split(sep).includes(sessionId)) continue;
      try {
        candidates.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // ignore unreadable files
      }
    }
  };
  walk(root, 0);
  return candidates.sort((left, right) => right.mtime - left.mtime)[0]?.path;
}

/**
 * Read a session log directly from `$DSH_HOME/sessions`.
 *
 * @throws Error with a user-readable message when the log or zstd support is missing.
 */
export function readSessionLogFile(
  sessionId: string,
  dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
): SessionExportData | undefined {
  const path = findSessionLog(sessionId, dshHome);
  if (path === undefined) return undefined;
  const bytes = readFileSync(path);
  let raw: string;
  if (path.endsWith('.zstd')) {
    const decompress = (zstdDecompressSync as unknown as ((input: Buffer) => Buffer) | undefined);
    if (typeof decompress !== 'function') {
      throw new Error('当前 Node.js 不支持 zstd 解压，无法读取会话日志');
    }
    raw = decompress(bytes).toString('utf8');
  } else {
    raw = bytes.toString('utf8');
  }
  return { messages: messagesFromJsonl(raw), rawJsonl: raw };
}

/** Markdown export with a bounded file size. */
export function renderExportMarkdown(input: {
  readonly sessionId: string;
  readonly title?: string;
  readonly now: number;
  readonly messages: readonly ExportMessage[];
}): string {
  const lines = [
    '# dsh 会话导出',
    '',
    `- sessionId: ${input.sessionId}`,
    `- 标题: ${input.title ?? '（无标题）'}`,
    `- 导出时间: ${new Date(input.now).toISOString()}`,
    `- 消息数: ${input.messages.length}`,
    '',
  ];
  for (const message of input.messages) {
    lines.push(`## ${message.role}${message.toolName === undefined ? '' : `: ${message.toolName}`}`);
    lines.push('```');
    lines.push(message.text);
    lines.push('```');
    lines.push('');
  }
  return truncateUtf8(lines.join('\n'), TRUNCATED_MARKER);
}

/** Raw JSONL export (one normalized message per line, bounded). */
export function renderExportJsonl(messages: readonly ExportMessage[]): string {
  const raw = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
  return truncateUtf8(raw, TRUNCATED_MARKER.trim());
}

/** Write one export file under the session cwd; returns the absolute path. */
export function writeExportFile(
  cwd: string,
  sessionId: string,
  extension: 'md' | 'jsonl',
  content: string,
  now: number,
): string {
  mkdirSync(cwd, { recursive: true });
  const target = join(
    cwd,
    `.caduceus-export-${sessionId.slice(0, 8)}-${now}.${extension}`,
  );
  writeFileSync(target, content);
  return target;
}
