import type { LoggerService } from '@nestjs/common';
import { logContext } from './log-context';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

/**
 * One JSON object per line on stdout: what log collectors (CloudWatch, Loki,
 * Datadog...) parse without configuration. Used as the application logger, so
 * Nest's own messages and every `new Logger(context)` in our code end up here.
 *
 * Callers log identifiers (transactionId, walletId, providerId, messageId),
 * never payloads, amounts or player data.
 */
export class JsonLogger implements LoggerService {
  private readonly minimum: number;

  constructor(
    level: LogLevel = 'info',
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.minimum = LEVELS.indexOf(level);
  }

  static isLevel(value: string): value is LogLevel {
    return (LEVELS as readonly string[]).includes(value);
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  // Nest calls logger.error(message, stack?, context?) and the others with
  // (message, context?): the context is always the last string argument.
  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    if (LEVELS.indexOf(level) < this.minimum) {
      return;
    }
    const strings = rest.filter((value): value is string => typeof value === 'string');
    const context = strings.length > 0 ? strings[strings.length - 1] : undefined;
    const stack = strings.length > 1 ? strings[0] : undefined;

    this.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        ...(context !== undefined && { context }),
        ...logContext.current(),
        ...fieldsOf(message),
        ...(stack !== undefined && { stack }),
      }),
    );
  }
}

function fieldsOf(message: unknown): Record<string, unknown> {
  if (message instanceof Error) {
    return { msg: message.message, error: message.name, stack: message.stack };
  }
  if (typeof message === 'object' && message !== null) {
    return message as Record<string, unknown>;
  }
  return { msg: String(message) };
}
