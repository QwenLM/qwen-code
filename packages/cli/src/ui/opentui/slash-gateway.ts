/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend-level gate between the prompt and the real slash dispatcher (R2).
 *
 * Dispatcher construction is asynchronous (the loader stack builds the
 * registry), so slash input that arrives first must not fall through to the
 * model. The gateway:
 *
 *  - queues slash submissions until initialization settles (`ready`);
 *  - records initialization failures and reports them to every later
 *    submission instead of silently misrouting `/help` to the model;
 *  - rejects a submission while a command is already running (the ink
 *    processor gates on isProcessing; the OpenTUI prompt does not disable);
 *  - routes Esc to `dispatcher.cancel()` while a command runs.
 */

import type {
  OpenTuiDispatchOutcome,
  OpenTuiSlashDispatcher,
} from './commands-dispatch.js';

export type SlashSettlement =
  /** The dispatcher processed the input (false = not a slash command). */
  | { kind: 'dispatched'; outcome: OpenTuiDispatchOutcome | false }
  /** The submission was refused before reaching the dispatcher. */
  | { kind: 'rejected'; reason: string };

export class OpenTuiSlashGateway {
  private dispatcher: OpenTuiSlashDispatcher | null = null;
  private initError: string | null = null;
  private busy = false;
  private readonly ready: Promise<void>;
  private readonly settleReady: () => void;

  constructor() {
    let resolveReady: () => void = () => {};
    this.ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.settleReady = resolveReady;
  }

  /** Marks the command stack ready (or replaces it after a reload). */
  attach(dispatcher: OpenTuiSlashDispatcher): void {
    this.dispatcher = dispatcher;
    this.settleReady();
  }

  /** Records a dispatcher initialization failure and unblocks queued input. */
  failInit(error: unknown): void {
    this.initError = error instanceof Error ? error.message : String(error);
    this.settleReady();
  }

  /** True once the dispatcher is attached and serving. */
  isReady(): boolean {
    return this.dispatcher !== null;
  }

  /**
   * Whether the command in `text` opted into running while a model turn
   * streams (dispatcher passthrough; false before the dispatcher attaches).
   */
  canRunDuringStreaming(text: string): boolean {
    return this.dispatcher?.canRunDuringStreaming(text) ?? false;
  }

  /** True while a dispatched command is still running. */
  isBusy(): boolean {
    return this.busy;
  }

  getInitError(): string | null {
    return this.initError;
  }

  /** Esc route: cancel the running command (parity of dispatcher.cancel). */
  cancel(): void {
    this.dispatcher?.cancel();
  }

  /**
   * Waits for readiness, then runs one input through the dispatcher. Rejects
   * while initialization failed or another command is in flight.
   */
  async dispatch(text: string): Promise<SlashSettlement> {
    await this.ready;
    if (!this.dispatcher) {
      return {
        kind: 'rejected',
        reason:
          'The command stack failed to initialize' +
          (this.initError ? ` (${this.initError})` : '') +
          '; slash commands are unavailable.',
      };
    }
    if (this.busy) {
      return {
        kind: 'rejected',
        reason: 'A slash command is already running.',
      };
    }
    this.busy = true;
    try {
      const outcome = await this.dispatcher.handle(text);
      return { kind: 'dispatched', outcome };
    } finally {
      this.busy = false;
    }
  }
}
