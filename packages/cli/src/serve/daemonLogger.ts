/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type DaemonLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface DaemonLogContext {
  route?: string;
  sessionId?: string;
  clientId?: string;
  childPid?: number;
  channelId?: string;
  [key: string]: unknown;
}

const FIXED_CTX_ORDER = [
  'route',
  'sessionId',
  'clientId',
  'childPid',
  'channelId',
] as const;

const FIXED_CTX_SET: ReadonlySet<string> = new Set(FIXED_CTX_ORDER);

function renderCtxValue(value: unknown): string {
  const s = String(value);
  return /[\s=]/.test(s) ? JSON.stringify(s) : s;
}

function renderCtx(ctx: DaemonLogContext | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  for (const key of FIXED_CTX_ORDER) {
    const v = ctx[key];
    if (v !== undefined && v !== null) {
      parts.push(`${key}=${String(v)}`);
    }
  }
  const extraKeys = Object.keys(ctx)
    .filter(
      (k) => !FIXED_CTX_SET.has(k) && ctx[k] !== undefined && ctx[k] !== null,
    )
    .sort();
  for (const key of extraKeys) {
    parts.push(`${key}=${renderCtxValue(ctx[key])}`);
  }
  return parts.length > 0 ? parts.join(' ') + ' ' : '';
}

function renderErr(err: Error | undefined): string {
  if (!err) return '';
  const body = err.stack ?? `${err.name ?? 'Error'}: ${err.message}`;
  return (
    body
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n') + '\n'
  );
}

export interface BuildDaemonLogLineArgs {
  level: DaemonLogLevel;
  message: string;
  now: Date;
  ctx?: DaemonLogContext;
  err?: Error;
}

export function buildDaemonLogLine(args: BuildDaemonLogLineArgs): string {
  const ts = args.now.toISOString();
  const ctxStr = renderCtx(args.ctx);
  return `${ts} [${args.level}] [DAEMON] ${ctxStr}${args.message}\n${renderErr(args.err)}`;
}

export interface DaemonLogger {
  info(message: string, ctx?: DaemonLogContext): void;
  warn(message: string, ctx?: DaemonLogContext): void;
  error(message: string, err?: Error | null, ctx?: DaemonLogContext): void;
  raw(line: string, level?: 'info' | 'warn' | 'error'): void;
  getLogPath(): string;
  getDaemonId(): string;
  flush(): Promise<void>;
}

export interface InitDaemonLoggerOptions {
  boundWorkspace: string;
  pid?: number;
  now?: () => Date;
  stderr?: (line: string) => void;
  baseDir?: string;
}

const NOOP_LOGGER: DaemonLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  raw: () => {},
  getLogPath: () => '',
  getDaemonId: () => '',
  flush: () => Promise.resolve(),
};

function isOptedOut(): boolean {
  const raw = process.env['QWEN_DAEMON_LOG_FILE'];
  if (!raw) return false;
  return ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function initDaemonLogger(_opts: InitDaemonLoggerOptions): DaemonLogger {
  if (isOptedOut()) return NOOP_LOGGER;
  throw new Error('initDaemonLogger: file path not implemented yet');
}
