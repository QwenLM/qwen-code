/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import util from 'node:util';
import { Storage } from '../config/storage.js';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface DebugLogSession {
  getSessionId: () => string;
}

export interface DebugLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

let ensureDebugDirPromise: Promise<void> | null = null;
let hasWriteFailure = false;
let globalSession: DebugLogSession | null = null;
const sessionContext = new AsyncLocalStorage<DebugLogSession>();

function isDebugLogFileEnabled(): boolean {
  const value = process.env['QWEN_DEBUG_LOG_FILE'];
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalized);
}

function getActiveSession(): DebugLogSession | null {
  return sessionContext.getStore() ?? globalSession;
}

function ensureDebugDirExists(): Promise<void> {
  if (!ensureDebugDirPromise) {
    ensureDebugDirPromise = fs
      .mkdir(Storage.getGlobalDebugDir(), { recursive: true })
      .then(() => undefined)
      .catch(() => {
        hasWriteFailure = true;
        ensureDebugDirPromise = null;
      });
  }
  return ensureDebugDirPromise ?? Promise.resolve();
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      }
      return arg;
    })
    .map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg)))
    .join(' ');
}

/**
 * Builds a log line in the format:
 * `2026-01-23T06:58:02.011Z [DEBUG] [TAG] message`
 *
 * Tag is optional. If not provided, format is:
 * `2026-01-23T06:58:02.011Z [DEBUG] message`
 */
function buildLogLine(level: LogLevel, message: string, tag?: string): string {
  const timestamp = new Date().toISOString();
  const tagPart = tag ? ` [${tag}]` : '';
  return `${timestamp} [${level}]${tagPart} ${message}\n`;
}

function writeLog(
  session: DebugLogSession,
  level: LogLevel,
  tag: string | undefined,
  args: unknown[],
): void {
  if (!isDebugLogFileEnabled()) {
    return;
  }

  const sessionId = session.getSessionId();
  const logFilePath = Storage.getDebugLogPath(sessionId);
  const message = formatArgs(args);
  const line = buildLogLine(level, message, tag);

  void ensureDebugDirExists()
    .then(() => fs.appendFile(logFilePath, line, 'utf8'))
    .catch(() => {
      hasWriteFailure = true;
    });
}

/**
 * Returns true if any debug log write has failed.
 * Used by the UI to show a degraded mode notice on startup.
 */
export function isDebugLoggingDegraded(): boolean {
  return hasWriteFailure;
}

/**
 * Resets the write failure tracking state.
 * Primarily useful for testing.
 */
export function resetDebugLoggingState(): void {
  hasWriteFailure = false;
  ensureDebugDirPromise = null;
}

/**
 * Sets the process-wide debug log session used by createDebugLogger().
 *
 * This is the default session used when there is no async-local session bound
 * via runWithDebugLogSession().
 */
export function setDebugLogSession(
  session: DebugLogSession | null | undefined,
) {
  globalSession = session ?? null;
}

/**
 * Runs a function with a session bound to the current async context.
 *
 * This is optional; createDebugLogger() falls back to the process-wide session
 * set via setDebugLogSession().
 */
export function runWithDebugLogSession<T>(
  session: DebugLogSession,
  fn: () => T,
): T {
  return sessionContext.run(session, fn);
}

/**
 * Creates a debug logger that writes to the current debug log session.
 *
 * Session resolution order:
 * 1) async-local session (runWithDebugLogSession)
 * 2) process-wide session (setDebugLogSession)
 */
export function createDebugLogger(tag?: string): DebugLogger {
  return {
    debug: (...args: unknown[]) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, 'DEBUG', tag, args);
    },
    info: (...args: unknown[]) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, 'INFO', tag, args);
    },
    warn: (...args: unknown[]) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, 'WARN', tag, args);
    },
    error: (...args: unknown[]) => {
      const session = getActiveSession();
      if (!session) return;
      writeLog(session, 'ERROR', tag, args);
    },
  };
}
