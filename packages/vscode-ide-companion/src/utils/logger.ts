/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as vscode from 'vscode';

export const LOG_LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type LogSink = (level: LogLevel, args: unknown[]) => void;

const sensitiveKeys = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'cookie',
  'password',
  'refreshtoken',
  'secret',
  'token',
]);

const defaultSink: LogSink = (level, args) => {
  globalThis.console[level](...args);
};

let sink = defaultSink;

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (key, nestedValue: unknown) => {
        const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
        if (sensitiveKeys.has(normalizedKey)) {
          return '<redacted>';
        }
        if (typeof nestedValue === 'bigint') {
          return `${nestedValue}n`;
        }
        if (nestedValue instanceof Error) {
          return nestedValue.stack ?? nestedValue.message;
        }
        if (typeof nestedValue === 'object' && nestedValue !== null) {
          if (seen.has(nestedValue)) {
            return '[Circular]';
          }
          seen.add(nestedValue);
        }
        return nestedValue;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

export function formatLogArgs(args: unknown[]): string {
  return args.map(formatValue).join(' ');
}

export function isLogLevel(value: unknown): value is LogLevel {
  return LOG_LEVELS.includes(value as LogLevel);
}

export function resetLoggerSink(): void {
  sink = defaultSink;
}

export const logger = {
  debug: (...args: unknown[]) => sink('debug', args),
  error: (...args: unknown[]) => sink('error', args),
  info: (...args: unknown[]) => sink('info', args),
  log: (...args: unknown[]) => sink('log', args),
  warn: (...args: unknown[]) => sink('warn', args),
};

export function createLogger(
  outputChannel: vscode.OutputChannel,
  sanitize: (message: string) => string = (message) => message,
): void {
  sink = (level, args) => {
    const label = level === 'log' ? 'INFO' : level.toUpperCase();
    outputChannel.appendLine(sanitize(`[${label}] ${formatLogArgs(args)}`));
  };
}
