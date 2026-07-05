/**
 * AutomationEventLogger - Logs automation events to events.jsonl
 *
 * CloudEvents-inspired schema with batched I/O for performance.
 * Append-only design for audit trail and replay capabilities.
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { ActionExecutionResult } from './types.ts';

// ============================================================================
// Types
// ============================================================================

export interface LoggedAutomationEvent {
  /** Unique event ID (UUID) */
  id: string;
  /** Event type (e.g., 'LabelAdd', 'PermissionModeChange') */
  type: string;
  /** ISO 8601 UTC timestamp */
  time: string;
  /** Origin identifier */
  source: string;
  /** Session context (if applicable) */
  sessionId?: string;
  /** Workspace context */
  workspaceId?: string;
  /** Event payload */
  data: Record<string, unknown>;
  /** Automation execution results */
  results: ActionExecutionResult[];
  /** Total execution time in milliseconds */
  durationMs: number;
}

export type LoggedAutomationEventInput = Omit<LoggedAutomationEvent, 'id' | 'time' | 'source'>;

// ============================================================================
// AutomationEventLogger Class
// ============================================================================

export class AutomationEventLogger {
  private logPath: string;
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private flushInProgress = false;
  private readonly FLUSH_DELAY_MS = 100;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 100;

  /** Optional callback when events are lost (after all retries fail) */
  onEventLost?: (events: string[], error: Error) => void;

  constructor(workspaceRootPath: string) {
    this.logPath = join(workspaceRootPath, 'events.jsonl');
  }

  /**
   * Log an event to the event stream.
   * Events are buffered and flushed after a short delay to coalesce rapid writes.
   */
  log(event: LoggedAutomationEventInput): void {
    if (this.isDisposed) {
      console.warn('[AutomationEventLogger] Attempted to log after disposal');
      return;
    }

    const entry: LoggedAutomationEvent = {
      id: randomUUID(),
      time: new Date().toISOString(),
      source: 'craft-agent/automations',
      ...event,
    };
    this.buffer.push(JSON.stringify(entry));
    this.scheduleFlush();
  }

  /**
   * Get the path to the event log file.
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Schedule a flush if not already scheduled.
   */
  private scheduleFlush(): void {
    if (!this.flushTimer && !this.isDisposed) {
      this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_DELAY_MS);
    }
  }

  /**
   * Flush buffered events to disk with retry logic.
   * Uses atomic buffer swap to prevent race conditions.
   */
  private async flush(): Promise<void> {
    this.flushTimer = null;

    // Prevent concurrent flushes
    if (this.flushInProgress) {
      this.scheduleFlush();
      return;
    }

    if (this.buffer.length === 0) return;

    this.flushInProgress = true;

    // Atomic buffer swap - take ownership of current buffer
    const toFlush = this.buffer;
    this.buffer = [];

    const lines = toFlush.join('\n') + '\n';
    let lastError: Error | null = null;

    // Retry with exponential backoff
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        await appendFile(this.logPath, lines, 'utf-8');
        this.flushInProgress = false;
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[AutomationEventLogger] Write failed (attempt ${attempt + 1}/${this.MAX_RETRIES}):`, error);

        if (attempt < this.MAX_RETRIES - 1) {
          // Wait before retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * Math.pow(2, attempt)));
        }
      }
    }

    // All retries failed - re-queue events at front of buffer for next attempt
    // or notify callback if provided
    this.flushInProgress = false;

    if (this.onEventLost) {
      this.onEventLost(toFlush, lastError!);
    } else {
      // Re-queue failed events at front of buffer
      this.buffer = [...toFlush, ...this.buffer];
      console.error(`[AutomationEventLogger] Events re-queued after ${this.MAX_RETRIES} failed attempts`);
    }
  }

  /**
   * Close the logger, flushing any remaining events.
   * Call this during application shutdown.
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /**
   * Dispose the logger, clearing timers and preventing further logging.
   * Alias for close() with additional cleanup.
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    await this.close();
    this.buffer = []; // Clear any remaining events
  }
}
