/**
 * Minimal logger seam shared by the transport, renderer, and bridge.
 *
 * Keeping the surface structural means unit tests can inject a recording
 * logger and the gateway can adapt the cordis logger without a dependency
 * cycle.
 *
 * @module @artomyuan/dsh-caduceus/logger
 */

export interface LoggerLike {
  info(message: string, ...args: readonly unknown[]): void;
  warn(message: string, ...args: readonly unknown[]): void;
  error(message: string, ...args: readonly unknown[]): void;
  debug(message: string, ...args: readonly unknown[]): void;
}

/** A logger that swallows everything (defaults in tests and pure helpers). */
export function silentLogger(): LoggerLike {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

/** Adapt the cordis `ctx.logger(name)` facade (printf-style) to {@link LoggerLike}. */
export function adaptLogger(logger: {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}): LoggerLike {
  return {
    info: (message, ...args) => logger.info(message, ...args),
    warn: (message, ...args) => logger.warn(message, ...args),
    error: (message, ...args) => logger.error(message, ...args),
    debug: (message, ...args) => logger.debug(message, ...args),
  };
}

/** Fan a line out to several loggers; one failing sink never blocks the others. */
export function teeLoggers(...loggers: readonly LoggerLike[]): LoggerLike {
  const call = (
    level: 'info' | 'warn' | 'error' | 'debug',
  ): ((message: string, ...args: readonly unknown[]) => void) => {
    return (message, ...args) => {
      for (const logger of loggers) {
        try {
          logger[level](message, ...args);
        } catch {
          // A broken sink (e.g. disk full) must not break the surface.
        }
      }
    };
  };
  return {
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    debug: call('debug'),
  };
}
