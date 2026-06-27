import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { readServiceInfo } from './pidfile.js';
import type { SessionTarget } from '@qwen-code/channel-base';

interface PersistedEntry {
  sessionId: string;
  target: SessionTarget;
  cwd: string;
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Show channel service status',
  handler: async () => {
    const info = readServiceInfo();

    if (!info) {
      writeStdoutLine('No channel service is running.');
      process.exit(0);
    }

    writeStdoutLine(`Channel service: running (PID ${info.pid})`);
    writeStdoutLine(`Uptime:          ${formatUptime(info.startedAt)}`);
    writeStdoutLine('');

    // Read session data for per-channel counts
    const sessionsPath = path.join(
      Storage.getGlobalQwenDir(),
      'channels',
      'sessions.json',
    );

    const sessionCounts = new Map<string, number>();
    if (existsSync(sessionsPath)) {
      try {
        const entries: Record<string, PersistedEntry> = JSON.parse(
          readFileSync(sessionsPath, 'utf-8'),
        );
        for (const entry of Object.values(entries)) {
          const name = entry.target.channelName;
          sessionCounts.set(name, (sessionCounts.get(name) || 0) + 1);
        }
      } catch {
        // best-effort
      }
    }

    // Table header
    const nameWidth = Math.max(15, ...info.channels.map((c) => c.length + 2));
    writeStdoutLine(`${'Channel'.padEnd(nameWidth)}Sessions`);
    writeStdoutLine(`${'-'.repeat(nameWidth)}--------`);

    for (const name of info.channels) {
      const count = sessionCounts.get(name) || 0;
      writeStdoutLine(`${name.padEnd(nameWidth)}${count}`);
    }

    process.exit(0);
  },
};
