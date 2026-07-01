/**
 * File notification channel - appends notifications to a log file.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { NotificationChannel, TaskNotification } from './channel.js';

export interface FileChannelConfig {
  path: string;
}

export class FileChannel implements NotificationChannel {
  name = 'file';
  private filePath: string;

  constructor(config: FileChannelConfig) {
    this.filePath = config.path;
  }

  async send(notification: TaskNotification): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const status = notification.status === 'success' ? '✓' : '✗';
    const duration = this.formatDuration(
      notification.startedAt,
      notification.endedAt,
    );

    const entry = [
      `[${notification.endedAt}] ${status} ${notification.taskName} (${notification.taskId})`,
      `  Status: ${notification.status} | Exit: ${notification.exitCode ?? 'N/A'} | Duration: ${duration}`,
      `  Time: ${notification.startedAt} → ${notification.endedAt}`,
      `  Output: ${notification.outputSummary.slice(0, 200)}`,
      notification.error ? `  Error: ${notification.error}` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n');

    await fs.appendFile(this.filePath, entry, 'utf-8');
  }

  async test(): Promise<boolean> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.access(dir, fsSync.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private formatDuration(startedAt: string, endedAt: string): string {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    const durationMs = end - start;

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }
}
