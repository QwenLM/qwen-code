/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createReadStream, watchFile, unwatchFile, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('REMOTE_INPUT');

/**
 * JSONL command shapes written by an external process (IDE extension,
 * web frontend, automation script) into the file passed to --input-file.
 *
 * - `submit`: enqueue a user message that the TUI processes as if typed
 *   into the prompt.
 * - `confirmation_response`: reply to a pending tool-permission
 *   `control_request` previously emitted on the dual-output channel.
 */
export type RemoteInputCommand =
  | { type: 'submit'; text: string }
  | { type: 'confirmation_response'; request_id: string; allowed: boolean };

/**
 * Callback invoked when a `confirmation_response` command is read.
 */
export type ConfirmationHandler = (requestId: string, allowed: boolean) => void;

/**
 * Callback type for submitting a query from remote input.
 * Returns true if the submit was accepted, false if rejected (TUI busy).
 */
export type SubmitFn = (
  query: string,
) => Promise<boolean | void> | boolean | void;

/**
 * Watches a JSONL file for remote input commands and calls the registered
 * submit function when new commands arrive.
 *
 * The watcher queues commands and retries when the TUI is busy (responding).
 * Call `notifyIdle()` when the TUI transitions to idle state to trigger
 * processing of queued commands.
 */
export class RemoteInputWatcher {
  private submitFn: SubmitFn | null = null;
  private confirmationHandler: ConfirmationHandler | null = null;
  private queue: Array<Extract<RemoteInputCommand, { type: 'submit' }>> = [];
  private processing = false;
  private active = true;
  private bytesRead = 0;
  private filePath: string;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.startWatching();
  }

  /**
   * Register the TUI's submit function. Called from AppContainer
   * once useGeminiStream's submitQuery is available.
   */
  setSubmitFn(fn: SubmitFn): void {
    this.submitFn = fn;
    this.processQueue();
  }

  /**
   * Register the handler invoked when a `confirmation_response` command is
   * read from the input file. Used to bridge external approvals back into
   * the tool's `onConfirm` callback.
   */
  setConfirmationHandler(fn: ConfirmationHandler): void {
    this.confirmationHandler = fn;
  }

  /**
   * Notify the watcher that the TUI has become idle.
   * Call this when streamingState transitions to Idle — it triggers
   * processing of any queued commands that were deferred due to TUI busy.
   */
  notifyIdle(): void {
    if (this.queue.length > 0 && !this.processing) {
      this.processQueue();
    }
  }

  private startWatching(): void {
    try {
      const stat = statSync(this.filePath);
      this.bytesRead = stat.size;
    } catch {
      this.bytesRead = 0;
    }

    watchFile(this.filePath, { interval: 500 }, () => {
      if (!this.active) return;
      this.readNewLines();
    });

    debugLogger.debug(`RemoteInput: watching ${this.filePath}`);
  }

  private readNewLines(): void {
    let currentSize: number;
    try {
      const stat = statSync(this.filePath);
      currentSize = stat.size;
    } catch {
      return;
    }

    if (currentSize <= this.bytesRead) return;

    const stream = createReadStream(this.filePath, {
      start: this.bytesRead,
      encoding: 'utf-8',
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const cmd = JSON.parse(trimmed);
        // confirmation_response is dispatched immediately rather than queued:
        // a pending tool call is blocking and the response must reach
        // onConfirm without waiting for any earlier `submit` to finish.
        if (
          cmd &&
          cmd.type === 'confirmation_response' &&
          typeof cmd.request_id === 'string' &&
          typeof cmd.allowed === 'boolean'
        ) {
          debugLogger.debug(
            `RemoteInput: confirmation_response for ${cmd.request_id} (allowed=${cmd.allowed})`,
          );
          this.confirmationHandler?.(cmd.request_id, cmd.allowed);
        } else if (
          cmd &&
          cmd.type === 'submit' &&
          typeof cmd.text === 'string'
        ) {
          debugLogger.debug(
            `RemoteInput: queued command: ${cmd.text.slice(0, 50)}...`,
          );
          this.queue.push(
            cmd as Extract<RemoteInputCommand, { type: 'submit' }>,
          );
        } else {
          debugLogger.warn(
            `RemoteInput: unknown command type: ${String(cmd?.type)}`,
          );
        }
      } catch (_err) {
        debugLogger.warn(`RemoteInput: failed to parse line: ${trimmed}`);
      }
    });

    rl.on('close', () => {
      this.bytesRead = currentSize;
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || !this.submitFn || this.queue.length === 0) return;

    this.processing = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    try {
      while (this.queue.length > 0 && this.active) {
        if (!this.submitFn) break;
        const cmd = this.queue[0]!; // peek, don't shift yet
        debugLogger.debug(
          `RemoteInput: submitting: ${cmd.text.slice(0, 50)}...`,
        );
        try {
          const result = await this.submitFn(cmd.text);
          // If submitFn returns false explicitly, the TUI rejected it (busy)
          if (result === false) {
            debugLogger.debug('RemoteInput: TUI busy, will retry on idle');
            this.scheduleRetry();
            break;
          }
          // Success — remove from queue
          this.queue.shift();
        } catch (err) {
          debugLogger.error('RemoteInput: submit failed:', err);
          this.queue.shift(); // remove failed command to avoid infinite retry
        }
        // Small delay between commands to let the TUI process
        if (this.queue.length > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    // Retry after 2s if notifyIdle hasn't been called
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.queue.length > 0 && !this.processing) {
        this.processQueue();
      }
    }, 2000);
  }

  shutdown(): void {
    this.active = false;
    unwatchFile(this.filePath);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.queue.length = 0;
    debugLogger.debug('RemoteInput: shut down');
  }
}
