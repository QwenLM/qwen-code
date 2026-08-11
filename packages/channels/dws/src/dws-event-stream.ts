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

function processError(code?: number | null): Error {
  return new Error(
    `DWS event consumer stopped${code === undefined || code === null ? '' : ` (${code})`}.`,
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
    let ready = false;
    let stopping = false;
    let settled = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });

    const settleError = (error: Error): void => {
      if (settled) {
        onError(error);
        return;
      }
      settled = true;
      clearTimeout(readyTimer);
      reject(error);
    };

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGTERM');
    };

    const readyTimer = setTimeout(() => {
      stop();
      settleError(
        new Error(
          `DWS event consumer did not become ready within ${READY_TIMEOUT_MS / 1000} seconds.`,
        ),
      );
    }, READY_TIMEOUT_MS);
    readyTimer.unref?.();

    stdout.on('line', (line) => {
      void Promise.resolve(onLine(line)).catch((error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      });
    });

    stderr.on('line', (line) => {
      if (line.includes('[event] ready') && !settled) {
        settled = true;
        ready = true;
        clearTimeout(readyTimer);
        resolve({ stop, closed });
      }
    });

    child.once('error', (error) => {
      settleError(
        new Error(
          `Failed to start DWS event consumer: ${sanitizeLogText(error.message, 300)}`,
        ),
      );
    });

    child.once('exit', (code) => {
      clearTimeout(readyTimer);
      stdout.close();
      stderr.close();
      resolveClosed();
      if (!ready) {
        settleError(processError(code));
      } else if (!stopping) {
        onError(processError(code));
      }
    });
  });
