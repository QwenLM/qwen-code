/**
 * Console notification channel - outputs notifications to stderr.
 */

import type { NotificationChannel, TaskNotification } from './channel.js';

export class ConsoleChannel implements NotificationChannel {
  name = 'console';

  async send(notification: TaskNotification): Promise<void> {
    const status = notification.status === 'success' ? '✓' : '✗';
    const duration = this.formatDuration(
      notification.startedAt,
      notification.endedAt,
    );

    process.stderr.write(
      `[${status}] ${notification.taskName} (${notification.taskId})\n` +
        `    Status: ${notification.status} | Exit: ${notification.exitCode ?? 'N/A'} | Duration: ${duration}\n` +
        `    Time: ${notification.startedAt} → ${notification.endedAt}\n` +
        `    Output: ${notification.outputSummary.slice(0, 200)}\n`,
    );

    if (notification.error) {
      process.stderr.write(`    Error: ${notification.error}\n`);
    }
  }

  async test(): Promise<boolean> {
    return true;
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
