/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as util from 'node:util';
import {
  diagnosticLogger,
  localISOString,
  type DiagnosticLogLevel,
} from './diagnosticLogger.js';

export type RunLogLevel = 'LOG' | 'WARN' | 'ERROR' | 'DEBUG';
/** @deprecated Use RunLogLevel. */
export type DebugLogLevel = RunLogLevel;

export interface RunLogEntry {
  level: RunLogLevel;
  message: string;
  timestamp: string;
}
/** @deprecated Use RunLogEntry. */
export type DebugLogEntry = RunLogEntry;

export type RunLogSink = (entry: RunLogEntry) => void;
/** @deprecated Use RunLogSink. */
export type DebugLogSink = RunLogSink;

const LEVEL_PRIORITY: Record<RunLogLevel, number> = {
  ERROR: 0,
  WARN: 1,
  LOG: 2,
  DEBUG: 3,
};

/**
 * Process-level persistent logger. Writes diagnostic messages to the
 * run-scoped process log under `~/.qwen/logs/runs/<runId>/`; the file name
 * follows the product build (`PROCESS_LOG_FILE_NAME`), e.g. `qwen.log`.
 * Writes go through `DiagnosticLogger`. Also emits to an optional log sink
 * (used by the TUI debug drawer).
 *
 * For session-loop event logging, use `sessionLogger` instead.
 */
class RunLogger {
  private _minLevel: RunLogLevel = 'LOG';
  private logSink: RunLogSink | null = null;

  /**
   * Set the minimum log level for output (both diagnostic file and sink).
   * Messages below this level are discarded entirely. Default is `'LOG'`
   * (debug messages are not written). Set to `'DEBUG'` when running in
   * debug mode to capture all messages.
   */
  set minLevel(level: RunLogLevel) {
    this._minLevel = level;
    // Keep DiagnosticLogger's level filter in sync.
    diagnosticLogger.minLevel =
      level === 'LOG' ? 'info' : (level.toLowerCase() as DiagnosticLogLevel);
  }

  get minLevel(): RunLogLevel {
    return this._minLevel;
  }

  /** Whether debug-level messages are being captured. */
  get isDebugEnabled(): boolean {
    return LEVEL_PRIORITY[this._minLevel] >= LEVEL_PRIORITY['DEBUG'];
  }

  /**
   * @deprecated Diagnostic logging is now auto-initialized on first write.
   * This method is a no-op retained for backward compatibility.
   */
  enableDebugLogging(_sessionId?: string): boolean {
    return true;
  }

  /**
   * Get the path to the current debug log file.
   */
  getDebugLogPath(): string | undefined {
    return diagnosticLogger.getProcessLogPath();
  }

  setLogSink(sink: RunLogSink | null): void {
    this.logSink = sink;
  }

  async close(): Promise<void> {
    diagnosticLogger.close();
  }

  private shouldLog(level: RunLogLevel): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this._minLevel];
  }

  private writeLogEntry(
    diagnosticLevel: DiagnosticLogLevel,
    sinkLevel: RunLogLevel,
    args: unknown[],
  ) {
    if (!this.shouldLog(sinkLevel)) return;
    diagnosticLogger.debugMessage(diagnosticLevel, args);
    this.emitToSink({
      level: sinkLevel,
      message: util.format(...args),
      timestamp: localISOString(),
    });
  }

  private emitToSink(entry: RunLogEntry): void {
    const sink = this.logSink;
    if (!sink) return;

    try {
      sink(entry);
    } catch {
      // Logging must never fail the caller.
    }
  }

  log(...args: unknown[]): void {
    this.writeLogEntry('info', 'LOG', args);
  }

  warn(...args: unknown[]): void {
    this.writeLogEntry('warn', 'WARN', args);
  }

  error(...args: unknown[]): void {
    this.writeLogEntry('error', 'ERROR', args);
  }

  debug(...args: unknown[]): void {
    this.writeLogEntry('debug', 'DEBUG', args);
  }
}

export const runLogger = new RunLogger();

/** @deprecated Use runLogger. */
export const debugLogger = runLogger;
