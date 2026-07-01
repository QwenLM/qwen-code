/**
 * Notification channel interface for sending task completion notifications.
 */

export interface TaskNotification {
  taskId: string;
  taskName: string;
  status: 'success' | 'failure' | 'timeout';
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  outputSummary: string;
  error?: string;
}

export interface NotificationChannel {
  name: string;
  send(notification: TaskNotification): Promise<void>;
  test(): Promise<boolean>;
}

export interface ChannelConfig {
  type: string;
  enabled: boolean;
  [key: string]: unknown;
}
