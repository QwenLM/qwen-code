/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { Storage, updateSymlink } from '@qwen-code/qwen-code-core';

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

function computeDaemonId(pid: number, boundWorkspace: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(boundWorkspace)
    .digest('hex')
    .slice(0, 8);
  return `serve-${pid}-${hash}`;
}

export function initDaemonLogger(opts: InitDaemonLoggerOptions): DaemonLogger {
  if (isOptedOut()) return NOOP_LOGGER;

  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? (() => new Date());
  const stderr = opts.stderr ?? writeStderrLine;
  const baseDir = opts.baseDir ?? Storage.getGlobalDebugDir();

  const daemonId = computeDaemonId(pid, opts.boundWorkspace);
  const daemonDir = nodePath.join(baseDir, 'daemon');
  const logPath = nodePath.join(daemonDir, `${daemonId}.log`);

  try {
    nodeFs.mkdirSync(daemonDir, { recursive: true });
    const firstLine = buildDaemonLogLine({
      level: 'INFO',
      message: `daemon started pid=${pid} workspace=${opts.boundWorkspace}`,
      now: now(),
    });
    nodeFs.appendFileSync(logPath, firstLine);
  } catch (err) {
    stderr(
      `qwen serve: daemon log disabled — init failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NOOP_LOGGER;
  }

  try {
    const aliasPath = nodePath.join(daemonDir, 'latest');
    void updateSymlink(aliasPath, logPath, { fallbackCopy: false }).catch(
      () => {
        // Best-effort. Symlink failure must not degrade primary writes.
      },
    );
  } catch {
    // Defensive: any sync throw is ignored.
  }

  let pending: Promise<void> = Promise.resolve();
  let degraded = false;

  const enqueueAppend = (line: string): void => {
    pending = pending.then(() =>
      nodeFs.promises.appendFile(logPath, line).catch((err) => {
        if (!degraded) {
          degraded = true;
          stderr(
            `qwen serve: daemon log write failed — entering degraded mode: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }),
    );
  };

  const teeLine = (
    level: DaemonLogLevel,
    message: string,
    ctx?: DaemonLogContext,
    err?: Error,
  ): void => {
    const line = buildDaemonLogLine({ level, message, now: now(), ctx, err });
    // stderr first (synchronous, preserves human-visible order), then file.
    stderr(line.trimEnd());
    enqueueAppend(line);
  };

  return {
    info: (message, ctx) => teeLine('INFO', message, ctx),
    warn: (message, ctx) => teeLine('WARN', message, ctx),
    error: (message, err, ctx) =>
      teeLine('ERROR', message, ctx, err ?? undefined),
    raw: (line: string, level: 'info' | 'warn' | 'error' = 'info') => {
      const upper = level.toUpperCase() as DaemonLogLevel;
      const formatted = `${now().toISOString()} [${upper}] [DAEMON] ${line}\n`;
      enqueueAppend(formatted);
    },
    getLogPath: () => logPath,
    getDaemonId: () => daemonId,
    flush: () => pending,
  };
}
