/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal stderr logger. The repository bans `console`; a daemon still needs
 * operator-facing diagnostics, and stderr is the right channel for them
 * (stdout carries the machine-readable listening line only).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class LiveLogger {
  constructor(
    private readonly minLevel: LogLevel = (process.env[
      'QWEN_LIVE_LOG_LEVEL'
    ] as LogLevel | undefined) ?? 'info',
  ) {}

  private write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < (LEVEL_ORDER[this.minLevel] ?? 20)) return;
    process.stderr.write(
      `[qwen-live] ${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`,
    );
  }

  debug(message: string): void {
    this.write('debug', message);
  }
  info(message: string): void {
    this.write('info', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  error(message: string): void {
    this.write('error', message);
  }
}
