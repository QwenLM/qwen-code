/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  readLockFile,
  isDaemonRunning,
  removeLockFile,
} from '../../daemon/lock-file.js';

export const stopCommand: CommandModule = {
  command: 'stop',
  describe: 'Stop the Qwen Code daemon',
  handler: async () => {
    const lock = readLockFile();

    if (!lock) {
      writeStdoutLine('No daemon is running (lock file not found).');
      return;
    }

    if (!isDaemonRunning(lock)) {
      writeStdoutLine(
        'Daemon is not running (stale lock file). Cleaning up...',
      );
      removeLockFile();
      return;
    }

    try {
      // Try graceful shutdown via API first
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      try {
        await fetch(
          `http://127.0.0.1:${lock.port}/api/stop?token=${lock.authToken}`,
          { signal: controller.signal },
        );
        clearTimeout(timeout);
        writeStdoutLine(`Daemon stopped (PID: ${lock.pid}).`);
        return;
      } catch {
        clearTimeout(timeout);
      }

      // Fallback: send SIGTERM
      process.kill(lock.pid, 'SIGTERM');
      writeStdoutLine(`Sent SIGTERM to daemon (PID: ${lock.pid}).`);

      // Wait briefly and check
      await new Promise((r) => setTimeout(r, 1000));
      if (isDaemonRunning(lock)) {
        process.kill(lock.pid, 'SIGKILL');
        writeStdoutLine('Daemon did not stop gracefully. Sent SIGKILL.');
      }

      removeLockFile();
      writeStdoutLine('Daemon stopped.');
    } catch (err) {
      writeStdoutLine(
        `Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`,
      );
      removeLockFile();
    }
  },
};
