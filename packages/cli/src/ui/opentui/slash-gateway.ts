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
 *  - routes Esc to `dispatcher.cancel()` while a command runs;
 *  - normalizes ink's bare quit tokens to `/quit` for the shell, ahead of the
 *    gate ({@link normalizeQuitSubmission}).
 */

import type {
  OpenTuiDispatchOutcome,
  OpenTuiSlashDispatcher,
} from './commands-dispatch.js';

// ink's quit family (AppContainer.handleFinalSubmit): `/exit` is quit's own
// altName, so the whole set collapses onto `/quit`.
const QUIT_TOKENS = new Set([
  '/quit',
  '/exit',
  'exit',
  'quit',
  ':q',
  ':q!',
  ':wq',
  ':wq!',
]);

/**
 * Rewrites a bare quit token to `/quit` so it reaches the dispatcher as the
 * command it means. ink checks this ahead of its message queue — a quit has to
 * be able to stop a live stream instead of queueing behind it, and anything the
 * gate leaves alone would otherwise be submitted to the model as text.
 */
export function normalizeQuitSubmission(text: string): string {
  return QUIT_TOKENS.has(text.trim()) ? '/quit' : text;
}

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
   * Whether a slash submission must wait for the in-flight model turn to end.
   * Answered from the real registry, so it awaits readiness exactly like
   * {@link dispatch}; a failed init has nothing to defer (dispatch reports it).
   */
  async mustDeferDuringStreaming(text: string): Promise<boolean> {
    await this.ready;
    return this.dispatcher?.mustDeferDuringStreaming(text) ?? false;
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
