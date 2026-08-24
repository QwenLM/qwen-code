/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { dwsProcessEnvironment } from './dws-environment.js';

const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

export class DwsEventProcessError extends Error {
  constructor(
    message: string,
    readonly retryable?: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DwsEventProcessError';
  }
}

export interface DwsEventSubscription {
  stop(): void;
  closed: Promise<void>;
}

export type DwsEventProcessStarter = (
  executable: string,
  args: string[],
  onLine: (line: string) => void | Promise<void>,
  onError: (error: Error) => void,
) => Promise<DwsEventSubscription>;

function processError(code?: number | null): DwsEventProcessError {
  return new DwsEventProcessError(
    `DWS event consumer stopped${code === undefined || code === null ? '' : ` (${code})`}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findValue(value: unknown, keys: ReadonlySet<string>): unknown {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        pending.push(current[index]);
      }
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [key, candidate] of Object.entries(current)) {
      if (keys.has(key)) return candidate;
    }
    const values = Object.values(current);
    for (let index = values.length - 1; index >= 0; index--) {
      pending.push(values[index]);
    }
  }
  return undefined;
}

function parseEventError(line: string): DwsEventProcessError | undefined {
  const jsonStart = line.indexOf('{');
  if (jsonStart < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(jsonStart)) as unknown;
  } catch {
    return undefined;
  }
  const retryable = findValue(parsed, new Set(['retryable']));
  const retryAfter = findValue(
    parsed,
    new Set(['retry_after_seconds', 'retryAfterSeconds']),
  );
  const nextRetry = findValue(
    parsed,
    new Set(['next_retry_at', 'nextRetryAt']),
  );
  const message = findValue(parsed, new Set(['message', 'hint']));
  if (
    typeof retryable !== 'boolean' &&
    typeof retryAfter !== 'number' &&
    typeof nextRetry !== 'string'
  ) {
    return undefined;
  }
  let retryAfterMs: number | undefined;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    retryAfterMs = Math.max(0, retryAfter * 1_000);
  } else if (typeof nextRetry === 'string') {
    const timestamp = Date.parse(nextRetry);
    if (Number.isFinite(timestamp))
      retryAfterMs = Math.max(0, timestamp - Date.now());
  }
  return new DwsEventProcessError(
    sanitizeLogText(
      typeof message === 'string' ? message : 'DWS event subscription failed.',
      300,
    ),
    typeof retryable === 'boolean' ? retryable : undefined,
    retryAfterMs,
  );
}

export const startDwsEventProcess: DwsEventProcessStarter = (
  executable,
  args,
  onLine,
  onError,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: dwsProcessEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    let state: 'pending' | 'ready' | 'failed' = 'pending';
    let stopping = false;
    let lastError: DwsEventProcessError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let lineQueue = Promise.resolve();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });

    const settleStartupError = (error: Error): void => {
      if (state !== 'pending') return;
      state = 'failed';
      clearTimeout(readyTimer);
      reject(error);
    };

    const reportError = (error: unknown): void => {
      try {
        onError(error instanceof Error ? error : new Error(String(error)));
      } catch {
        return;
      }
    };

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, STOP_TIMEOUT_MS);
        killTimer.unref?.();
      }
    };

    const readyTimer = setTimeout(() => {
      stop();
      settleStartupError(
        new Error(
          `DWS event consumer did not become ready within ${READY_TIMEOUT_MS / 1000} seconds.`,
        ),
      );
    }, READY_TIMEOUT_MS);
    readyTimer.unref?.();

    stdout.on('line', (line) => {
      if (child.exitCode === null && child.signalCode === null) {
        lastError = undefined;
      }
      child.stdout.pause();
      lineQueue = lineQueue
        .then(() => onLine(line))
        .catch((error: unknown) => {
          reportError(error);
        })
        .finally(() => {
          if (!stopping) child.stdout.resume();
        });
    });

    stderr.on('line', (line) => {
      if (line.includes('[event] ready') && state === 'pending') {
        state = 'ready';
        clearTimeout(readyTimer);
        resolve({ stop, closed });
        return;
      }
      lastError = parseEventError(line) ?? lastError;
    });

    child.once('error', (error) => {
      const resolvedError = new DwsEventProcessError(
        `Failed to start DWS event consumer: ${sanitizeLogText(error.message, 300)}`,
      );
      if (state === 'pending') settleStartupError(resolvedError);
      else if (state === 'ready' && !stopping) lastError = resolvedError;
    });

    child.once('close', (code) => {
      clearTimeout(readyTimer);
      if (killTimer) clearTimeout(killTimer);
      void lineQueue.finally(() => {
        stdout.close();
        stderr.close();
        resolveClosed();
        if (state === 'pending') {
          settleStartupError(lastError ?? processError(code));
        } else if (state === 'ready' && !stopping) {
          reportError(lastError ?? processError(code));
        }
      });
    });
  });
