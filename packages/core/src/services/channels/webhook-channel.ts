/**
 * Webhook notification channel - sends notifications via HTTP POST.
 */

import type { NotificationChannel, TaskNotification } from './channel.js';

export interface WebhookChannelConfig {
  url: string;
  headers?: Record<string, string>;
  method?: 'POST' | 'PUT';
}

export class WebhookChannel implements NotificationChannel {
  name = 'webhook';
  private url: string;
  private headers: Record<string, string>;
  private method: 'POST' | 'PUT';

  constructor(config: WebhookChannelConfig) {
    this.url = config.url;
    this.headers = config.headers || { 'Content-Type': 'application/json' };
    this.method = config.method || 'POST';
  }

  async send(notification: TaskNotification): Promise<void> {
    const payload = {
      taskId: notification.taskId,
      taskName: notification.taskName,
      status: notification.status,
      startedAt: notification.startedAt,
      endedAt: notification.endedAt,
      exitCode: notification.exitCode,
      outputSummary: notification.outputSummary,
      error: notification.error,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(this.url, {
      method: this.method,
      headers: this.headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `Webhook request failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  async test(): Promise<boolean> {
    try {
      const testNotification: TaskNotification = {
        taskId: 'test',
        taskName: 'Test Notification',
        status: 'success',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        exitCode: 0,
        outputSummary: 'Test notification from qwen schedule daemon',
      };

      await this.send(testNotification);
      return true;
    } catch {
      return false;
    }
  }
}
