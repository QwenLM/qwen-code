/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type { IPty } from '@lydell/node-pty';
import type pkg from '@xterm/headless';

/** Timeout in milliseconds before escalating to SIGKILL. */
export const SIGKILL_TIMEOUT_MS = 200;

export interface ActivePty {
  ptyProcess: IPty;
  headlessTerminal: pkg.Terminal;
}

export interface ProcessCleanupStrategy {
  killPty(pid: number, pty: ActivePty): void;
  killChildProcesses(pids: Set<number>): void;
}

export const windowsStrategy: ProcessCleanupStrategy = {
  killPty: (_pid, pty) => {
    pty.ptyProcess.kill();
  },
  killChildProcesses: (pids) => {
    if (pids.size > 0) {
      try {
        const args = ['/f', '/t'];
        for (const pid of pids) {
          args.push('/pid', pid.toString());
        }
        spawnSync('taskkill', args);
      } catch {
        // ignore
      }
    }
  },
};

export const posixStrategy: ProcessCleanupStrategy = {
  killPty: (pid, _pty) => {
    process.kill(-pid, 'SIGKILL');
  },
  killChildProcesses: (pids) => {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  },
};

export const getCleanupStrategy = (): ProcessCleanupStrategy =>
  os.platform() === 'win32' ? windowsStrategy : posixStrategy;

/**
 * Gets the full buffer text from a headless terminal.
 */
export const getFullBufferText = (terminal: pkg.Terminal): string => {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const lineContent = line ? line.translateToString() : '';
    lines.push(lineContent);
  }
  return lines.join('\n').trimEnd();
};
