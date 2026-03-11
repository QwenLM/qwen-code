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
  verifyDaemonProcess,
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

    // Verify the process is actually our daemon (not a PID reuse)
    const isDaemon = await verifyDaemonProcess(lock);
    if (!isDaemon) {
      writeStdoutLine(
        'Process exists but does not appear to be the daemon. Cleaning up lock file...',
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
          { method: 'POST', signal: controller.signal },
        );
        clearTimeout(timeout);

        // Wait for the process to actually exit
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 300));
          if (!isDaemonRunning(lock)) {
            writeStdoutLine(`Daemon stopped (PID: ${lock.pid}).`);
            return;
          }
        }
        // Process didn't exit via API, fall through to SIGTERM
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
