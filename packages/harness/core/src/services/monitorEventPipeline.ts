/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const TOKEN_CAPACITY = 10;
const TOKEN_REFILL_MS = 2_000;
const OVERLOAD_STOP_MS = 30_000;
const MAX_EVENT_LINE_CHARS = 500;
const MAX_EVENT_BATCH_CHARS = 3_000;
const BATCH_WINDOW_MS = 200;
const MAX_INCOMPLETE_LINE_CHARS = 1_048_576;

export interface MonitorEventPipelineOptions {
  emitEvent: (event: string) => void;
  emitHousekeeping: (event: string) => void;
  stopForOverload: () => void;
  now?: () => number;
  schedule?: (callback: () => void) => () => void;
}

/**
 * Converts stdout chunks into bounded line batches and applies Monitor's
 * event-rate policy before delivering them to the owning agent.
 */
export class MonitorEventPipeline {
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => () => void;
  private incompleteLine = '';
  private pendingLines: string[] = [];
  private cancelScheduledFlush: (() => void) | undefined;
  private tokens = TOKEN_CAPACITY;
  private lastRefillAt: number;
  private suppressedEvents = 0;
  private overloadStartedAt: number | undefined;
  private lastSuppressedAt: number | undefined;
  private stopped = false;

  constructor(private readonly options: MonitorEventPipelineOptions) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback) => {
        const timer = setTimeout(callback, BATCH_WINDOW_MS);
        return () => clearTimeout(timer);
      });
    this.lastRefillAt = this.now();
  }

  onData(chunk: string): void {
    if (this.stopped || chunk.length === 0) return;

    this.incompleteLine += chunk;
    if (this.incompleteLine.length > MAX_INCOMPLETE_LINE_CHARS) {
      this.incompleteLine = this.incompleteLine.slice(
        -MAX_INCOMPLETE_LINE_CHARS,
      );
    }

    if (this.incompleteLine.includes('\n')) {
      // Split once (O(L)) instead of repeated slice (O(L²)) — this is the
      // stdout hot path for high-rate monitor output.
      const parts = this.incompleteLine.split('\n');
      this.incompleteLine = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trim();
        if (line.length > 0) this.pendingLines.push(truncateEventLine(line));
      }
    }

    if (this.pendingLines.length > 0 && !this.cancelScheduledFlush) {
      this.cancelScheduledFlush = this.schedule(() => this.flush(false));
    }
  }

  flush(includeIncompleteLine: boolean): void {
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = undefined;

    if (includeIncompleteLine && this.incompleteLine.trim()) {
      this.pendingLines.push(truncateEventLine(this.incompleteLine.trim()));
      this.incompleteLine = '';
    }
    if (this.pendingLines.length === 0) return;

    let event = this.pendingLines.join('\n');
    this.pendingLines = [];
    if (event.length > MAX_EVENT_BATCH_CHARS) {
      event = `${event.slice(0, MAX_EVENT_BATCH_CHARS)}\n...(truncated)`;
    }
    this.deliver(event);
  }

  close(): void {
    if (this.stopped) return;
    try {
      this.flush(true);
    } finally {
      this.dispose();
    }
  }

  /**
   * Stops the pipeline without delivering buffered output.
   *
   * Use this when the monitor never started successfully. Normal process exit
   * must use close() so the final unterminated stdout line is still delivered.
   */
  dispose(): void {
    this.stopped = true;
    this.cancelScheduledFlush?.();
    this.cancelScheduledFlush = undefined;
    this.incompleteLine = '';
    this.pendingLines = [];
  }

  private deliver(event: string): void {
    if (this.stopped) return;
    const now = this.now();
    this.refillTokens(now);

    if (this.tokens > 0) {
      this.tokens--;
      if (this.suppressedEvents > 0) {
        this.options.emitHousekeeping(
          `[${this.suppressedEvents} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
        );
        this.suppressedEvents = 0;
        if (
          this.lastSuppressedAt !== undefined &&
          now - this.lastSuppressedAt > TOKEN_REFILL_MS * 3
        ) {
          this.overloadStartedAt = undefined;
        }
      }
      this.options.emitEvent(event);
      return;
    }

    this.suppressedEvents++;
    this.lastSuppressedAt = now;
    this.overloadStartedAt ??= now;
    if (now - this.overloadStartedAt > OVERLOAD_STOP_MS) {
      this.dispose();
      this.options.emitHousekeeping(
        `[Monitor stopped — your script produced too much output (${this.suppressedEvents} events suppressed over ${Math.round((now - this.overloadStartedAt) / 1000)}s). Write a new monitor command that filters more aggressively — a tighter grep --line-buffered pattern or a wrapper script that only emits the specific events you need.]`,
      );
      this.options.stopForOverload();
    }
  }

  private refillTokens(now: number): void {
    const refillCount = Math.floor((now - this.lastRefillAt) / TOKEN_REFILL_MS);
    if (refillCount <= 0) return;
    this.tokens = Math.min(TOKEN_CAPACITY, this.tokens + refillCount);
    this.lastRefillAt += refillCount * TOKEN_REFILL_MS;
  }
}

function truncateEventLine(line: string): string {
  return line.length > MAX_EVENT_LINE_CHARS
    ? `${line.slice(0, MAX_EVENT_LINE_CHARS)}...(truncated)`
    : line;
}
