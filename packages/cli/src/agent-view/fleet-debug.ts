/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getAgentViewStorePaths } from './supervisor-store.js';

/**
 * Opt-in tracing for the Fleet subprocess lifecycle.
 *
 * Fleet spawns the supervisor and every teammate detached from the leader's
 * terminal, because the leader owns the TUI and any inherited stdio would
 * corrupt the Ink render. That makes the usual "read the stack trace" loop
 * unavailable, so subprocess output is captured to per-session log files
 * instead and this flag adds lifecycle breadcrumbs around the parts that fail
 * before a worker can report anything over the socket: spawn, handshake, auth
 * and config load.
 */
export const FLEET_DEBUG_ENV = 'QWEN_FLEET_DEBUG';

/** Bytes of subprocess output retained for diagnostics after a worker exits. */
export const FLEET_LOG_TAIL_BYTES = 4096;

export function isFleetDebugEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[FLEET_DEBUG_ENV];
  return value !== undefined && value !== '' && value !== '0';
}

/**
 * Write a lifecycle breadcrumb. Silent unless the flag is set.
 *
 * In the supervisor and in teammates, stderr is already redirected to a log
 * file, so breadcrumbs land next to any crash output. In the leader, stderr is
 * the user's terminal and Ink owns it — writing there would corrupt the render,
 * so leader-side breadcrumbs are appended to a shared debug log instead.
 */
export function fleetDebug(
  scope: string,
  message: string,
  fields: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isFleetDebugEnabled(env)) return;
  const line = formatFleetDebug(scope, message, fields);
  if (!process.stderr.isTTY) {
    process.stderr.write(line);
    return;
  }
  try {
    const logPath = getAgentViewStorePaths().fleetDebugLogPath;
    syncFs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    syncFs.appendFileSync(logPath, line, { mode: 0o600 });
  } catch {
    // Diagnostics must never take down the leader.
  }
}

export function formatFleetDebug(
  scope: string,
  message: string,
  fields: Record<string, unknown> = {},
): string {
  const parts = Object.entries(fields).map(
    ([key, value]) => `${key}=${formatField(value)}`,
  );
  const suffix = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `[fleet:${scope}] ${new Date().toISOString()} pid=${process.pid} ${message}${suffix}\n`;
}

function formatField(value: unknown): string {
  if (typeof value === 'string') {
    return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value instanceof Error) return JSON.stringify(value.message);
  if (value === undefined) return '-';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Open a truncating log file for a subprocess and seed it with a header.
 *
 * Truncating rather than appending keeps {@link readFleetLogTail} scoped to the
 * current run; Stage 1B never respawns a worker into an existing session id, so
 * there is no earlier run in this file worth preserving.
 *
 * Returns undefined when the log cannot be opened — an unwritable home
 * directory degrades diagnostics but must never stop a teammate from starting.
 */
export function openFleetLogFd(
  logPath: string,
  header: Record<string, unknown> = {},
): number | undefined {
  try {
    syncFs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const fd = syncFs.openSync(logPath, 'w', 0o600);
    syncFs.writeSync(fd, formatFleetDebug('spawn', 'log opened', header));
    return fd;
  } catch {
    return undefined;
  }
}

export function closeFleetLogFd(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    syncFs.closeSync(fd);
  } catch {
    // The child owns a dup of this descriptor; losing the parent's copy is
    // not worth surfacing.
  }
}

/**
 * Read the last {@link FLEET_LOG_TAIL_BYTES} of a subprocess log.
 *
 * Returns undefined when the file is missing or empty so callers can omit the
 * detail rather than reporting an empty diagnostic.
 */
export async function readFleetLogTail(
  logPath: string,
  maxBytes = FLEET_LOG_TAIL_BYTES,
): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(logPath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return undefined;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8').trim();
    if (text.length === 0) return undefined;
    return size > length ? `…${text}` : text;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Build the operator-facing failure message for a worker that exited early.
 *
 * Always names the log file, because the tail is capped and the full output is
 * the thing an operator actually needs next.
 */
export function describeWorkerExit(
  exitCode: number | null,
  logPath: string,
  tail?: string,
): string {
  const code =
    exitCode === null ? 'terminated by signal' : `exit code ${exitCode}`;
  const detail = tail ? `\nLast output:\n${tail}` : '';
  return `Fleet teammate process ended (${code}). Full log: ${logPath}${detail}`;
}
