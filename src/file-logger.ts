/**
 * Durable file logger for the surface.
 *
 * Real-device problem: the plugin's `ctx.logger` lines never reached the
 * journal, while another plugin's did, so operator-visible diagnostics were
 * impossible. This logger writes its own file:
 *
 * ```text
 * 2026-10-31T21:07:35.123Z INFO  [caduceus] message
 * ```
 *
 * - `<DSH_HOME>/caduceus/caduceus.log` (directory created as needed, file 0600);
 * - `info`/`warn`/`error` by default; `debug` only when level = 'debug';
 * - rotation: when the file exceeds `maxBytes` (default 5 MB) it becomes
 *   `.1`, older files shift to `.2`/`.3`, and at most `maxFiles` (default 3)
 *   rotated files are kept.
 *
 * Write failures are contained (`onError`, default stderr-once) — logging must
 * never affect message delivery.
 *
 * @module @artomyuan/dsh-caduceus/file-logger
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { defaultLogPath } from './home.js';
import { silentLogger, type LoggerLike } from './logger.js';

/** File log verbosity. */
export type FileLogLevel = 'info' | 'debug';

/** 5 MB per file. */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Keep `.1`, `.2`, `.3`. */
export const DEFAULT_LOG_MAX_FILES = 3;
/** Prefix shown in each line. */
export const DEFAULT_LOG_NAME = 'caduceus';

export interface FileLoggerOptions {
  /** Absolute path; defaults to `<DSH_HOME>/caduceus/caduceus.log`. */
  readonly filePath?: string;
  /** `info` (default) or `debug`. */
  readonly level?: FileLogLevel;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly name?: string;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** One formatted log line (exported for tests/docs). */
export function formatLogLine(
  timestampIso: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  name: string,
  message: string,
): string {
  return `${timestampIso} ${level.toUpperCase().padEnd(5)} [${name}] ${message}\n`;
}

/** Durable, rotating file logger. */
export class FileLogger implements LoggerLike {
  readonly filePath: string;
  readonly level: FileLogLevel;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly name: string;

  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  #writeFailed = false;

  constructor(options: FileLoggerOptions = {}) {
    this.filePath = options.filePath ?? defaultLogPath();
    this.level = options.level ?? 'info';
    this.maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_LOG_MAX_FILES;
    this.name = options.name ?? DEFAULT_LOG_NAME;
    this.#now = options.now ?? Date.now;
    this.#onError =
      options.onError ??
      ((error: unknown) => {
        if (this.#writeFailed) return;
        this.#writeFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`caduceus: file log unavailable: ${message}\n`);
      });
  }

  debug(message: string, ...args: readonly unknown[]): void {
    if (this.level !== 'debug') return;
    this.#write('debug', message, args);
  }

  info(message: string, ...args: readonly unknown[]): void {
    this.#write('info', message, args);
  }

  warn(message: string, ...args: readonly unknown[]): void {
    this.#write('warn', message, args);
  }

  error(message: string, ...args: readonly unknown[]): void {
    this.#write('error', message, args);
  }

  #write(level: 'debug' | 'info' | 'warn' | 'error', message: string, args: readonly unknown[]): void {
    try {
      const text =
        args.length === 0 ? message : `${message} ${args.map((arg) => String(arg)).join(' ')}`;
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      this.#rotateIfNeeded();
      appendFileSync(this.filePath, formatLogLine(this.#timestamp(), level, this.name, text), {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // Best effort: an existing file with looser mode still gets used.
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  #timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  #rotateIfNeeded(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return; // Missing file: nothing to rotate.
    }
    if (size <= this.maxBytes) return;
    // Drop the oldest, shift down, then current -> .1
    rmSync(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
      } catch {
        // Missing shifted file: skip.
      }
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}

/** A logger that swallows everything (useful as a FileLogger fallback in tests). */
export function silentFileLogger(): LoggerLike {
  return silentLogger();
}
