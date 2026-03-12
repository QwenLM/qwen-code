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

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Show daemon status',
  handler: async () => {
    const lock = readLockFile();

    if (!lock) {
      writeStdoutLine('Daemon is not running.');
      return;
    }

    if (!isDaemonRunning(lock)) {
      writeStdoutLine(
        'Daemon is not running (stale lock file). Cleaning up...',
      );
      removeLockFile();
      return;
    }

    writeStdoutLine('Daemon is running:');
    writeStdoutLine(`  PID:        ${lock.pid}`);
    writeStdoutLine(`  Port:       ${lock.port}`);
    writeStdoutLine(`  CWD:        ${lock.cwd}`);
    writeStdoutLine(`  Started at: ${lock.startedAt}`);
    writeStdoutLine(
      `  Access URL: http://127.0.0.1:${lock.port}/?token=${lock.authToken}`,
    );

    // Try to get session count from API
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(
        `http://127.0.0.1:${lock.port}/api/sessions?token=${lock.authToken}`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      if (response.ok) {
        const sessions = (await response.json()) as Array<{
          sessionId: string;
        }>;
        writeStdoutLine(`  Sessions:   ${sessions.length}`);
      }
    } catch {
      // API not reachable, that's fine - we already confirmed PID is running
    }
  },
};
