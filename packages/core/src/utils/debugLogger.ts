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
let aliasGeneration = 0;
let aliasFailureStreak = 0;
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
  aliasGeneration += 1;
  aliasFailureStreak = 0;
  aliasChain = Promise.resolve();
}

const DEBUG_LATEST_ALIAS = 'latest';
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// After this many consecutive alias-update failures the dedup marker stays
// sticky (one attempt per session change, the pre-retry behavior) instead of
// retrying on every write — bounds the cost on hosts where symlinks always
// fail. A single success resets the streak.
const MAX_CONSECUTIVE_ALIAS_FAILURES = 3;

async function doUpdateLatestDebugLogAlias(
  sessionId: string,
): Promise<boolean> {
  const aliasPath = path.join(Storage.getGlobalDebugDir(), DEBUG_LATEST_ALIAS);
  const targetPath = Storage.getDebugLogPath(sessionId);

  await ensureDebugDirExists();
  await updateSymlink(aliasPath, targetPath, { fallbackCopy: false });
  try {
    const actualTarget = await fs.readlink(aliasPath);
    return actualTarget === path.relative(path.dirname(aliasPath), targetPath);
  } catch {
    return false;
  }
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
  const generation = ++aliasGeneration;

  // Serialize alias updates so interleaved writes from different sessions
  // don't race unlink/symlink into an inconsistent state.
  aliasChain = aliasChain.then(async () => {
    let updated = false;
    try {
      updated = await doUpdateLatestDebugLogAlias(sessionId);
    } catch {
      // Best-effort; don't degrade overall logging
    }
    if (updated) {
      aliasFailureStreak = 0;
      return;
    }
    // Clearing the marker lets the session's next write retry a transient
    // failure — but only below the streak cap: where symlinks never work
    // (e.g. Windows without symlink privilege) the marker must stay sticky,
    // or every debug line would re-run a doomed unlink/symlink cycle.
    aliasFailureStreak += 1;
    if (
      aliasFailureStreak < MAX_CONSECUTIVE_ALIAS_FAILURES &&
      aliasGeneration === generation
    ) {
      lastAliasedKey = null;
    }
  });
}

/**
 * Sets the process-wide debug log session used by createDebugLogger().
 *
 * This is the fallback used when neither runWithDebugLogSession() nor
 * sessionIdContext has bound an async-local session.
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
 * This overrides both sessionIdContext and the process-wide session set via
 * setDebugLogSession().
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
