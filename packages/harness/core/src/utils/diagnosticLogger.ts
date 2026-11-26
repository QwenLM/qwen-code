/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import { redactSecrets } from './diagnosticRedaction.js';
import { getConfigHomeDir, sanitizePath } from './paths.js';
import { CLI_VERSION as GENERATED_CLI_VERSION } from '../generated/git-commit.js';
import { BRAND_PROCESS_LOG_STEM, ENV_REMOTE_WORKER } from '../config/brand.js';
import { maskTokenCountForPublicOutput } from '../protocol/token-usage-visibility.js';

/**
 * Name of the run-scoped process log. Follows the product's log stem rather
 * than its binary name, so builds keep `qwen.log` on every site
 * while other products name their own log. Older runs keep the name they were
 * written with in `manifest.json` (`log_files.process`), so readers of past
 * runs must not assume this value.
 */
export const PROCESS_LOG_FILE_NAME = `${BRAND_PROCESS_LOG_STEM}.log`;

/**
 * Return an ISO-8601 timestamp in the user's **local** timezone,
 * e.g. `2026-04-25T16:03:12.345+08:00`.
 *
 * Using local time makes log files much easier to correlate with
 * the developer's wall clock when debugging.
 */
export function localISOString(date: Date = new Date()): string {
  const offsetMin = date.getTimezoneOffset(); // e.g. -480 for UTC+8
  const local = new Date(date.getTime() - offsetMin * 60_000);
  const iso = local.toISOString().slice(0, -1); // drop trailing 'Z'

  if (offsetMin === 0) {
    return `${iso}Z`;
  }
  const sign = offsetMin <= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  return `${iso}${sign}${hh}:${mm}`;
}

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DiagnosticEventKind =
  | 'process'
  | 'cli'
  | 'input'
  | 'session'
  | 'turn'
  | 'loop'
  | 'model'
  | 'tool'
  | 'permission'
  | 'hook'
  | 'feedback'
  | 'error';

export interface DiagnosticIds {
  project_id?: string;
  session_id?: string;
  turn_id?: string;
  loop_id?: string;
  stream_id?: string;
  request_id?: string;
  tool_call_id?: string;
  permission_id?: string;
  span_id?: string;
  parent_span_id?: string;
}

export interface DiagnosticEventInput {
  level: DiagnosticLogLevel;
  kind: DiagnosticEventKind;
  type: string;
  summary?: string;
  ids?: DiagnosticIds;
  data?: Record<string, unknown>;
  /**
   * Internal control for retaining exact token counters in the per-session
   * JSONL segment. The process log remains masked.
   */
  preserveSessionTokenUsage?: boolean;
}

interface DiagnosticEvent extends DiagnosticEventInput {
  ts: string;
  seq: number;
  run_id: string;
  pid: number;
}

interface SessionSegmentEvent {
  ts: string;
  seq: number;
  level: DiagnosticLogLevel;
  type: string;
  turn_id?: string;
  loop_id?: string;
  request_id?: string;
  tool_call_id?: string;
  permission_id?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Exit context types
// ---------------------------------------------------------------------------

/**
 * Broad categories for *why* the process is exiting.
 *
 * Values are intentionally short and greppable in log files.
 */
export type ExitReason =
  /** Normal completion — no error. */
  | 'success'
  /** User pressed Ctrl+C. */
  | 'signal_int'
  /** SIGTERM / SIGHUP received. */
  | 'signal_term'
  /** TTY stdin+stdout both lost (detached terminal). */
  | 'tty_loss'
  /** Uncaught exception crashed the process. */
  | 'uncaught_exception'
  /** Unhandled promise rejection. */
  | 'unhandled_rejection'
  /** Authentication failure. */
  | 'auth_error'
  /** Invalid CLI input or arguments. */
  | 'input_error'
  /** Configuration error. */
  | 'config_error'
  /** User cancelled an operation (e.g. OAuth flow). */
  | 'cancelled'
  /** Cleanup timed out, forced exit. */
  | 'cleanup_timeout'
  /** FatalError thrown by application code. */
  | 'fatal_error'
  /** Catch-all for unexpected / unclassified exits. */
  | 'unknown';

/**
 * Contextual information about *why* the process is exiting.
 *
 * Call {@link DiagnosticLogger.setExitContext} from every exit path to populate
 * this before the `'exit'` event fires.
 */
export interface ExitContext {
  /** High-level reason category. */
  reason: ExitReason;
  /** Expected exit code (mirrors process.exitCode / the arg to process.exit). */
  exit_code?: number;
  /** Human-readable summary, e.g. "SIGTERM received" or error message. */
  message?: string;
  /** Source location or subsystem that initiated the exit, e.g. "cleanup.gracefulShutdown". */
  source?: string;
  /** Error name (e.g. "FatalError", "TypeError"). */
  error_name?: string;
  /** Truncated stack trace (first 2000 chars). */
  error_stack?: string;
  /** The signal that triggered the exit, if any. */
  signal?: string;
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Recursively normalize a value for safe JSON serialization.
 *
 * Handles circular references, Error objects, bigints, functions, and symbols.
 * If the serialized result exceeds `maxSerializedLength`, returns a truncated
 * preview wrapper instead.
 *
 * All string values are run through {@link redactSecrets} to strip API keys,
 * Bearer tokens, passwords, and other credential patterns before they reach
 * the log file.
 */
export function normalizeDiagnosticValue(
  value: unknown,
  maxSerializedLength = 12000,
): unknown {
  const seen = new WeakSet<object>();
  let estimatedSize = 0;
  const sizeExceeded = () => estimatedSize > maxSerializedLength;

  const normalize = (current: unknown): unknown => {
    if (
      current === null ||
      typeof current === 'number' ||
      typeof current === 'boolean'
    ) {
      estimatedSize += 8;
      return current;
    }
    if (typeof current === 'string') {
      const redacted = redactSecrets(current);
      estimatedSize += redacted.length + 2;
      return redacted;
    }
    if (typeof current === 'bigint') {
      estimatedSize += 16;
      return current.toString();
    }
    if (typeof current === 'undefined') {
      return undefined;
    }
    if (typeof current === 'function' || typeof current === 'symbol') {
      const s = String(current);
      estimatedSize += s.length + 2;
      return s;
    }
    if (Array.isArray(current)) {
      if (sizeExceeded()) return '[…]';
      return current.map((item) => normalize(item));
    }
    if (current instanceof Error) {
      estimatedSize += (current.stack?.length ?? current.message.length) + 32;
      return {
        name: current.name,
        message: current.message,
        stack: current.stack,
      };
    }
    if (typeof current === 'object') {
      if (seen.has(current)) {
        return '[Circular]';
      }
      if (sizeExceeded()) return '[…]';
      seen.add(current);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        const normalized = normalize(item);
        if (normalized !== undefined) {
          out[key] = normalized;
        }
      }
      seen.delete(current);
      return out;
    }
    return String(current);
  };

  const normalized = normalize(value);
  if (!sizeExceeded()) {
    return normalized;
  }
  // Only fall back to full serialization when the estimate says it's too big
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined || serialized.length <= maxSerializedLength) {
    return normalized;
  }
  return {
    truncated: true,
    serialized_length: serialized.length,
    preview: serialized.slice(0, maxSerializedLength),
  };
}

export function summarizeDiagnosticText(
  text: string,
  maxPreviewLength = 2000,
): {
  text_preview: string;
  text_length: number;
  truncated: boolean;
} {
  const preview =
    text.length > maxPreviewLength ? text.slice(0, maxPreviewLength) : text;
  return {
    text_preview: redactSecrets(preview),
    text_length: text.length,
    truncated: text.length > maxPreviewLength,
  };
}

interface DiagnosticManifest {
  run_id: string;
  started_at: string;
  pid: number;
  ppid: number;
  process_role: string;
  cli_version: string;
  node_version: string;
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  project_id: string;
  argv: string[];
  env_flags: Record<string, boolean>;
  log_files: {
    process: string;
  };
}

function makeRunId(startedAt: Date): string {
  const timestamp = localISOString(startedAt).replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}-p${process.pid}`;
}

function resolveProcessRole(): string {
  if (process.env[ENV_REMOTE_WORKER] === '1') {
    return 'remote-worker';
  }
  return 'main';
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function idsLabel(ids: DiagnosticIds | undefined): string {
  if (!ids) {
    return '';
  }
  const parts = [
    ['session', ids.session_id],
    ['turn', ids.turn_id],
    ['loop', ids.loop_id],
    ['stream', ids.stream_id],
    ['request', ids.request_id],
    ['tool', ids.tool_call_id],
    ['permission', ids.permission_id],
    ['span', ids.span_id],
  ].flatMap(([key, value]) => (value ? [`${key}=${value}`] : []));
  return parts.length > 0 ? `[${parts.join(' ')}] ` : '';
}

function compactData(data: Record<string, unknown> | undefined): string {
  if (!data) {
    return '';
  }
  const text = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  return text ? ` ${text}` : '';
}

function isEmptyPlainObject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

const redundantFalseDataKeys = new Set([
  'is_error',
  'denied_by_permission',
  'updated_input',
  'truncated',
]);

const TOKEN_USAGE_DATA_KEYS = new Set([
  'after_token_count',
  'before_token_count',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cached_content_token_count',
  'compact_token_usage_json',
  'completion_tokens',
  'current_tokens',
  'history_size_tokens',
  'input_token_count',
  'input_tokens',
  'output_token_count',
  'output_tokens',
  'overflow_tokens',
  'prompt_tokens',
  'thoughts_token_count',
  'thinking_tokens',
  'token_count',
  'tokens_after',
  'tokens_after_compact',
  'tokens_before',
  'tokens_before_compact',
  'tokens_saved',
  'tool_token_count',
  'total_cache_read_tokens',
  'total_cache_write_tokens',
  'total_input_tokens',
  'total_output_tokens',
  'total_thinking_tokens',
  'total_token_count',
  'total_tokens',
  'true_after_token_count',
]);

function maskDiagnosticTokenUsage(
  value: unknown,
  key?: string,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (
    key &&
    TOKEN_USAGE_DATA_KEYS.has(key) &&
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return maskTokenCountForPublicOutput(value);
  }

  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) {
      output.push(maskDiagnosticTokenUsage(item, undefined, seen));
    }
    return output;
  }

  if (value && typeof value === 'object' && isPlainObject(value)) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }
    const output: Record<string, unknown> = {};
    seen.set(value, output);
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = maskDiagnosticTokenUsage(childValue, childKey, seen);
    }
    return output;
  }

  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function maskDiagnosticData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }
  return maskDiagnosticTokenUsage(data) as Record<string, unknown>;
}

function compactSegmentData(
  data: Record<string, unknown> | undefined,
  ids: DiagnosticIds | undefined,
): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    if (isEmptyPlainObject(value)) {
      continue;
    }
    if (value === false && redundantFalseDataKeys.has(key)) {
      continue;
    }
    if (key === 'request_id' && value === ids?.request_id) {
      continue;
    }
    output[key] = value;
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function toSessionSegmentEvent(event: DiagnosticEvent): SessionSegmentEvent {
  const ids = event.ids;
  const segmentEvent: SessionSegmentEvent = {
    ts: event.ts,
    seq: event.seq,
    level: event.level,
    type: event.type,
    turn_id: ids?.turn_id,
    loop_id: ids?.loop_id,
    request_id: ids?.request_id,
    tool_call_id: ids?.tool_call_id,
    permission_id: ids?.permission_id,
    data: compactSegmentData(event.data, ids),
  };

  for (const key of Object.keys(segmentEvent) as Array<
    keyof SessionSegmentEvent
  >) {
    if (segmentEvent[key] === undefined) {
      delete segmentEvent[key];
    }
  }

  return segmentEvent;
}

function formatLogLine(params: {
  ts: string;
  level: DiagnosticLogLevel;
  type: string;
  ids?: DiagnosticIds;
  summary?: string;
  data?: Record<string, unknown>;
}): string {
  const summary = params.summary ? ` ${params.summary}` : '';
  return `${params.ts} ${params.level.toUpperCase().padEnd(5)} ${idsLabel(
    params.ids,
  )}${params.type}${summary}${compactData(params.data)}\n`;
}

interface LogWriter {
  write(line: string): void;
  close(): void;
}

function createLogWriter(filePath: string): LogWriter | undefined {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'a');
    return {
      write(line: string): void {
        fs.writeSync(fd, line);
      },
      close(): void {
        fs.closeSync(fd);
      },
    };
  } catch {
    return undefined;
  }
}

const DIAGNOSTIC_LEVEL_PRIORITY: Record<DiagnosticLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

class DiagnosticLogger {
  private readonly startedAt = new Date();
  private readonly runId = makeRunId(this.startedAt);
  private readonly logsRoot = path.join(getConfigHomeDir(), 'logs');
  private readonly runDir = path.join(this.logsRoot, 'runs', this.runId);
  private readonly processLogPath = path.join(
    this.runDir,
    PROCESS_LOG_FILE_NAME,
  );
  private readonly manifestPath = path.join(this.runDir, 'manifest.json');
  private seq = 0;
  private _minLevel: DiagnosticLogLevel = 'info';
  private initialized = false;
  private closed = false;
  private processLogWriter: LogWriter | undefined;
  private readonly sessionLogWriters = new Map<string, LogWriter>();
  private readonly ensuredSessionDirs = new Set<string>();
  private readonly sessionProjectIds = new Map<string, string>();
  private exitContext: ExitContext | undefined;
  private readonly handleProcessExit = (code?: number): void => {
    this.close(code);
  };

  constructor() {
    process.once('exit', this.handleProcessExit);
  }

  set minLevel(level: DiagnosticLogLevel) {
    this._minLevel = level;
  }

  get minLevel(): DiagnosticLogLevel {
    return this._minLevel;
  }

  private shouldLog(level: DiagnosticLogLevel): boolean {
    return (
      DIAGNOSTIC_LEVEL_PRIORITY[level] <=
      DIAGNOSTIC_LEVEL_PRIORITY[this._minLevel]
    );
  }

  getRunId(): string {
    return this.runId;
  }

  getRunDir(): string {
    return this.runDir;
  }

  getProcessLogPath(): string {
    return this.processLogPath;
  }

  /**
   * Bind the session's project directory for segment paths. A process that
   * hosts several sessions (daemon) cannot derive the project from its own
   * cwd, so the session declares it instead.
   */
  bindSessionProject(sessionId: string, projectDir: string): void {
    this.sessionProjectIds.set(sessionId, sanitizePath(projectDir));
  }

  clearSessionProject(sessionId: string): void {
    this.sessionProjectIds.delete(sessionId);
  }

  /**
   * Record *why* the process is about to exit.
   *
   * Call this from every exit path **before** `process.exit()` is invoked so
   * that the final `process.exiting` log line includes rich context.  Multiple
   * calls are allowed — the first call wins (the initial reason is usually the
   * root cause; later calls may come from cascading cleanup).
   */
  setExitContext(ctx: ExitContext): void {
    if (!this.exitContext) {
      this.exitContext = ctx;
    }
  }

  /** Lazily initialize on first write to avoid sync I/O at module load. */
  private ensureInitialized(): boolean {
    if (this.initialized) {
      return true;
    }
    if (this.closed) {
      return false;
    }
    try {
      fs.mkdirSync(this.runDir, { recursive: true });
      fs.writeFileSync(
        this.manifestPath,
        JSON.stringify(this.createManifest(), null, 2) + '\n',
        'utf8',
      );
      this.processLogWriter = createLogWriter(this.processLogPath);
      this.updateLatestSymlink();
      this.initialized = true;
      this.event({
        level: 'info',
        kind: 'process',
        type: 'process.started',
        data: {
          run_id: this.runId,
          pid: process.pid,
          role: resolveProcessRole(),
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private createManifest(): DiagnosticManifest {
    const cwd = process.cwd();
    const generatedVersion = String(GENERATED_CLI_VERSION);
    return {
      run_id: this.runId,
      started_at: localISOString(this.startedAt),
      pid: process.pid,
      ppid: process.ppid,
      process_role: resolveProcessRole(),
      cli_version:
        generatedVersion !== 'UNKNOWN'
          ? generatedVersion
          : (process.env['CLI_VERSION'] ?? 'unknown'),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd,
      project_id: sanitizePath(cwd),
      argv: process.argv.slice(),
      env_flags: {
        debug: !!process.env['DEBUG'],
        remote_worker: process.env[ENV_REMOTE_WORKER] === '1',
        ci: !!process.env['CI'],
      },
      log_files: {
        process: PROCESS_LOG_FILE_NAME,
      },
    };
  }

  private updateLatestSymlink(): void {
    const latestPath = path.join(this.logsRoot, 'latest');
    try {
      fs.rmSync(latestPath, { recursive: true, force: true });
      fs.symlinkSync(path.relative(this.logsRoot, this.runDir), latestPath);
    } catch {
      // Symlink is best-effort; run dir is the source of truth.
    }
  }

  private getOrCreateSessionWriter(
    ids: DiagnosticIds | undefined,
  ): LogWriter | undefined {
    if (!ids?.session_id) {
      return undefined;
    }
    const projectId =
      ids.project_id ??
      this.sessionProjectIds.get(ids.session_id) ??
      sanitizePath(process.cwd());
    const sessionDir = path.join(
      this.logsRoot,
      'sessions',
      projectId,
      ids.session_id,
      'segments',
    );
    const jsonlPath = path.join(sessionDir, `${this.runId}.jsonl`);
    let writer = this.sessionLogWriters.get(jsonlPath);
    if (writer) {
      return writer;
    }
    if (!this.ensuredSessionDirs.has(sessionDir)) {
      try {
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch {
        return undefined;
      }
      this.ensuredSessionDirs.add(sessionDir);
    }
    writer = createLogWriter(jsonlPath);
    if (writer) {
      this.sessionLogWriters.set(jsonlPath, writer);
    }
    return writer;
  }

  event(input: DiagnosticEventInput): void {
    if (!this.shouldLog(input.level)) {
      return;
    }
    if (!this.ensureInitialized()) {
      return;
    }
    const seq = ++this.seq;
    const { preserveSessionTokenUsage = false, ...eventInput } = input;
    const event: DiagnosticEvent = {
      ts: localISOString(),
      seq,
      run_id: this.runId,
      pid: process.pid,
      ...eventInput,
      data: maskDiagnosticData(input.data),
    };

    try {
      const logLine = formatLogLine(event);
      this.processLogWriter?.write(logLine);
      const sessionWriter = this.getOrCreateSessionWriter(event.ids);
      if (sessionWriter) {
        const sessionEvent = preserveSessionTokenUsage
          ? { ...event, data: input.data }
          : event;
        sessionWriter.write(
          JSON.stringify(toSessionSegmentEvent(sessionEvent)) + '\n',
        );
      }
    } catch {
      this.initialized = false;
    }
  }

  text(
    level: DiagnosticLogLevel,
    type: string,
    summary?: string,
    data?: Record<string, unknown>,
    ids?: DiagnosticIds,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }
    if (!this.ensureInitialized()) {
      return;
    }
    try {
      this.processLogWriter?.write(
        formatLogLine({
          ts: localISOString(),
          level,
          type,
          summary,
          data: maskDiagnosticData(data),
          ids,
        }),
      );
    } catch {
      this.initialized = false;
    }
  }

  debugMessage(level: DiagnosticLogLevel, args: unknown[]): void {
    this.text(
      level,
      'debug.message',
      util.format(...args.map((arg) => maskDiagnosticTokenUsage(arg))),
    );
  }

  close(processExitCode?: number): void {
    if (this.closed) {
      return;
    }
    if (this.initialized && this.processLogWriter) {
      // Resolve the most informative exit code: explicit arg > context > process.exitCode
      const exitCode =
        processExitCode ??
        this.exitContext?.exit_code ??
        process.exitCode ??
        undefined;
      const ctx = this.exitContext;
      const data: Record<string, unknown> = {};
      // Always include exit_code when available
      if (exitCode !== undefined) {
        data['exit_code'] = exitCode;
      }
      // Include all available context fields
      if (ctx) {
        data['reason'] = ctx.reason;
        if (ctx.message) {
          data['message'] = ctx.message;
        }
        if (ctx.source) {
          data['source'] = ctx.source;
        }
        if (ctx.signal) {
          data['signal'] = ctx.signal;
        }
        if (ctx.error_name) {
          data['error_name'] = ctx.error_name;
        }
        if (ctx.error_stack) {
          data['error_stack'] = ctx.error_stack.slice(0, 2000);
        }
      } else {
        // No explicit context was set — infer a reason from the exit code
        if (exitCode === 0 || exitCode === undefined) {
          data['reason'] = 'success';
        } else {
          data['reason'] = 'unknown';
          data['message'] = 'no exit context was set before process.exit()';
        }
      }
      // Uptime since process start
      data['uptime_ms'] = Date.now() - this.startedAt.getTime();
      const level = exitCode !== undefined && exitCode !== 0 ? 'warn' : 'info';
      const logLine = formatLogLine({
        ts: localISOString(),
        level,
        type: 'process.exiting',
        data,
      });
      try {
        this.processLogWriter.write(logLine);
      } catch {
        // Best-effort
      }
    }
    this.closed = true;
    try {
      this.processLogWriter?.close();
    } catch {
      // Best-effort
    }
    this.processLogWriter = undefined;
    for (const writer of this.sessionLogWriters.values()) {
      try {
        writer.close();
      } catch {
        // Best-effort
      }
    }
    this.sessionLogWriters.clear();
    process.off('exit', this.handleProcessExit);
  }
}

export const sessionLogger = new DiagnosticLogger();

/** @deprecated Use sessionLogger. */
export const diagnosticLogger = sessionLogger;
