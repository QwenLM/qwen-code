/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import util from 'node:util';
import { Storage } from '../config/storage.js';
import { updateSymlink } from './symlink.js';
import {
  getTraceContext,
  type TraceContext,
} from '../telemetry/trace-context.js';
import { sessionIdContext } from './sessionIdContext.js';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface DebugLogSession {
  getSessionId: () => string;
}

export interface DebugLogger {
  isEnabled: () => boolean;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

let ensureDebugDirPromise: Promise<void> | null = null;
let ensuredDebugDirPath: string | null = null;
let hasWriteFailure = false;
let globalSession: DebugLogSession | null = null;
let lastAliasedKey: string | null = null;
let aliasChain: Promise<void> = Promise.resolve();
const sessionContext = new AsyncLocalStorage<DebugLogSession | false>();

export function isDebugLogFileEnabled(): boolean {
  const value = process.env['QWEN_DEBUG_LOG_FILE'];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return !['', '0', 'false', 'off', 'no'].includes(normalized);
}

function getActiveSession(): DebugLogSession | null {
  const contextSession = sessionContext.getStore();
  if (contextSession === false) return null;
  if (contextSession) return contextSession;

  // In daemon/ACP mode one process hosts many concurrent sessions. The async
  // context already carries the owning session ID via sessionIdContext, so
  // prefer it over the process-wide session set by Config creation. Without
  // this, creating a Config for session B would redirect logs belonging to
  // session A's in-flight work into session B's debug log file.
  const sessionId = sessionIdContext.getStore();
  if (sessionId) {
    return { getSessionId: () => sessionId };
  }

  return globalSession;
}

function ensureDebugDirExists(): Promise<void> {
  const debugDirPath = Storage.getGlobalDebugDir();
  if (!ensureDebugDirPromise || ensuredDebugDirPath !== debugDirPath) {
    ensuredDebugDirPath = debugDirPath;
    ensureDebugDirPromise = fs
      .mkdir(debugDirPath, { recursive: true })
      .then(() => undefined)
      .catch(() => {
        hasWriteFailure = true;
        ensureDebugDirPromise = null;
        ensuredDebugDirPath = null;
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
 * `2026-01-23T06:58:02.011Z [DEBUG] [TAG] [trace_id=xxx span_id=yyy] message`
 *
 * Tag and trace context are optional.
 */
function buildLogLine(
  level: LogLevel,
  message: string,
  tag?: string,
  traceCtx?: TraceContext | null,
): string {
  const timestamp = new Date().toISOString();
  const tagPart = tag ? ` [${tag}]` : '';
  const tracePart = traceCtx
    ? ` [trace_id=${traceCtx.traceId} span_id=${traceCtx.spanId}]`
    : '';
  return `${timestamp} [${level}]${tagPart}${tracePart} ${message}\n`;
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
  const traceCtx = getTraceContext();
  const line = buildLogLine(level, message, tag, traceCtx);

  // In a multi-session daemon the active session can change between writes.
  // Keep the `latest` alias pointed at the file that is actually receiving
  // logs right now, not just the last Config that was constructed.
  updateLatestDebugLogAlias(sessionId);

  void ensureDebugDirExists()
    // Debug logs are best-effort diagnostic output: 1050+ call sites,
    // default-enabled, fire-and-forget. Per-line fsync would force
    // continuous I/O pressure / SSD wear without user benefit — losing
    // the last few hundred ms of debug output on crash is acceptable
    // and the module already tracks `hasWriteFailure` for the
    // degraded-mode UI. Kernel page-cache flush is sufficient here.
    // (JSONL session writes via writeLine/writeLineSync DO use
    // flush:true — those are the actual closure target.)
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
  ensuredDebugDirPath = null;
  lastAliasedKey = null;
  aliasChain = Promise.resolve();
}

const DEBUG_LATEST_ALIAS = 'latest';
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function doUpdateLatestDebugLogAlias(sessionId: string): Promise<void> {
  const aliasPath = path.join(Storage.getGlobalDebugDir(), DEBUG_LATEST_ALIAS);
  const targetPath = Storage.getDebugLogPath(sessionId);

  return ensureDebugDirExists()
    .then(() => updateSymlink(aliasPath, targetPath, { fallbackCopy: false }))
    .catch(() => {
      // Best-effort; don't degrade overall logging
    });
}

function updateLatestDebugLogAlias(sessionId: string): void {
  if (!isDebugLogFileEnabled()) {
    return;
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return;
  }

  // Key by directory + id so runtime base dir changes still get their own
  // alias; skip when the alias already points at the same file.
  const key = path.join(Storage.getGlobalDebugDir(), sessionId);
  if (key === lastAliasedKey) {
    return;
  }
  lastAliasedKey = key;

  // Serialize alias updates so interleaved writes from different sessions
  // don't race unlink/symlink into an inconsistent state.
  aliasChain = aliasChain.then(() => doUpdateLatestDebugLogAlias(sessionId));
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
  if (session) {
    updateLatestDebugLogAlias(session.getSessionId());
  }
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

export function runWithoutDebugLogSession<T>(fn: () => T): T {
  return sessionContext.run(false, fn);
}

/**
 * Creates a debug logger that writes to the current debug log session.
 *
 * Session resolution order:
 * 1) async-local suppression or session (runWithoutDebugLogSession / runWithDebugLogSession)
 * 2) async-local session ID from the daemon context (sessionIdContext)
 * 3) process-wide session (setDebugLogSession)
 */
export function createDebugLogger(tag?: string): DebugLogger {
  return {
    isEnabled: () => getActiveSession() !== null,
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
