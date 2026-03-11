/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { readLockFile, isDaemonRunning } from '../../daemon/lock-file.js';
import type { DaemonSessionInfo } from '../../daemon/types.js';

export const sessionsCommand: CommandModule = {
  command: 'sessions',
  describe: 'List active daemon sessions',
  handler: async () => {
    const lock = readLockFile();

    if (!lock) {
      writeStdoutLine('Daemon is not running.');
      return;
    }

    if (!isDaemonRunning(lock)) {
      writeStdoutLine('Daemon is not running.');
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(
        `http://127.0.0.1:${lock.port}/api/sessions?token=${lock.authToken}`,
        { signal: controller.signal },
      );
      clearTimeout(timeout);

      if (!response.ok) {
        writeStdoutLine(`Failed to fetch sessions: HTTP ${response.status}`);
        return;
      }

      const sessions = (await response.json()) as DaemonSessionInfo[];

      if (sessions.length === 0) {
        writeStdoutLine('No active sessions.');
        return;
      }

      writeStdoutLine(`Active sessions (${sessions.length}):\n`);

      for (const session of sessions) {
        const shortId = session.sessionId.slice(0, 8);
        const prompt = session.prompt || '(no prompt)';
        const truncatedPrompt =
          prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;

        writeStdoutLine(`  ${shortId}  ${truncatedPrompt}`);
        writeStdoutLine(
          `           Clients: ${session.clientCount}  Created: ${session.createdAt}`,
        );
        writeStdoutLine(
          `           URL: http://127.0.0.1:${lock.port}/session/${session.sessionId}?token=${lock.authToken}`,
        );
        writeStdoutLine('');
      }
    } catch (err) {
      writeStdoutLine(
        `Failed to fetch sessions: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
