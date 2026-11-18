/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-scoped /btw state shared by every surface (TUI, ACP, daemon).
 *
 * The session owns each side-question request: it runs the forked query,
 * accumulates streamed text and retry state, and records an answered exchange
 * exactly once. Answered exchanges are threaded into later side questions.
 * Nothing here enters the transcript; a new session id starts empty.
 */

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { runForkedAgent } from './forkedAgent.js';
import { buildBtwCacheSafeParams, buildBtwPrompt } from '../utils/btwUtils.js';
import type { RetryInfo } from '../utils/rateLimit.js';

/** Answered exchanges kept per session, and settled requests kept for display. */
export const BTW_HISTORY_LIMIT = 20;

export interface BtwExchange {
  readonly id: string;
  readonly question: string;
  readonly response: string;
}

export interface BtwRetryState {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly message?: string;
  /** Absolute time of the next attempt, so a late viewer counts down correctly. */
  readonly retryAt: number;
}

export type BtwOutcome =
  | { readonly kind: 'answered'; readonly response: string }
  /** The model tried to call a tool instead of answering. */
  | { readonly kind: 'tool-call'; readonly toolName: string }
  | { readonly kind: 'empty' }
  /** The session has no conversation context to fork yet. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly error: string; readonly cause: unknown }
  | { readonly kind: 'cancelled' };

export interface BtwRequest {
  readonly id: string;
  readonly question: string;
  readonly streamingText: string;
  readonly retry: BtwRetryState | null;
  /** `null` while the request is running. */
  readonly outcome: BtwOutcome | null;
}

export interface BtwSnapshot {
  /** Answered exchanges in completion order. The id matches the request id. */
  readonly exchanges: readonly BtwExchange[];
  /** Requests in submission order: every running one plus recent settled ones. */
  readonly requests: readonly BtwRequest[];
}

export interface BtwAskOptions {
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  /** Text already passed to `onText` was discarded by a restarting retry. */
  onReset?: () => void | Promise<void>;
}

export interface BtwRunParams {
  config: Config;
  question: string;
  history: ReadonlyArray<{ question: string; response: string }>;
  signal: AbortSignal;
  onText: (text: string) => Promise<void>;
  onRetry: (event: {
    restart: boolean;
    retryInfo?: RetryInfo;
  }) => Promise<void>;
}

export interface BtwUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface BtwRunResult {
  text: string | null;
  toolCallName?: string;
  usage?: BtwUsage;
}

/** What `ask()` settles with: the outcome plus usage when the model ran. */
export type BtwAskResult = BtwOutcome & { readonly usage?: BtwUsage };

/** Returns null when the session has no conversation context to fork. */
export type BtwRunner = (params: BtwRunParams) => Promise<BtwRunResult | null>;

export const runBtwQuery: BtwRunner = async (params) => {
  const cacheSafeParams = buildBtwCacheSafeParams(
    params.config,
    params.history,
    { fullHistory: true },
  );
  if (!cacheSafeParams) return null;
  const result = await runForkedAgent({
    config: params.config,
    userMessage: buildBtwPrompt(params.question),
    cacheSafeParams,
    abortSignal: params.signal,
    fullHistory: true,
    preserveTools: true,
    disableFunctionCalls: true,
    onText: params.onText,
    onRetry: params.onRetry,
  });
  return {
    text: result.text,
    toolCallName: result.toolCallName,
    usage: {
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  };
};

export class BtwSession {
  private snapshot: BtwSnapshot = { exchanges: [], requests: [] };
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly config: Config,
    private readonly runner: BtwRunner = runBtwQuery,
    private readonly now: () => number = Date.now,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): BtwSnapshot => this.snapshot;

  getRequest(id: string): BtwRequest | undefined {
    return this.snapshot.requests.find((request) => request.id === id);
  }

  /** The newest running request, else the newest answered exchange. */
  getReopenTargetId(): string | undefined {
    const running = this.snapshot.requests.findLast(
      (request) => request.outcome === null,
    );
    return running?.id ?? this.snapshot.exchanges.at(-1)?.id;
  }

  ask(
    question: string,
    options: BtwAskOptions = {},
  ): { id: string; done: Promise<BtwAskResult> } {
    const id = randomUUID();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;

    const history = this.snapshot.exchanges.map(({ question, response }) => ({
      question,
      response,
    }));
    this.commit({
      ...this.snapshot,
      requests: [
        ...this.snapshot.requests,
        { id, question, streamingText: '', retry: null, outcome: null },
      ],
    });

    const onText = async (text: string) => {
      const request = this.getRunning(id);
      if (!request) return;
      this.updateRequest(id, {
        streamingText: request.streamingText + text,
        retry: null,
      });
      await options.onText?.(text);
    };
    const onRetry = async ({
      restart,
      retryInfo,
    }: {
      restart: boolean;
      retryInfo?: RetryInfo;
    }) => {
      const request = this.getRunning(id);
      if (!request) return;
      this.updateRequest(id, {
        ...(restart ? { streamingText: '' } : {}),
        ...(retryInfo
          ? {
              retry: {
                attempt: retryInfo.attempt,
                maxRetries: retryInfo.maxRetries,
                ...(retryInfo.message ? { message: retryInfo.message } : {}),
                retryAt: this.now() + retryInfo.delayMs,
              },
            }
          : {}),
      });
      if (restart && request.streamingText) await options.onReset?.();
    };

    const done = (async (): Promise<BtwAskResult> => {
      let outcome: BtwOutcome;
      let usage: BtwUsage | undefined;
      try {
        const result = await this.runner({
          config: this.config,
          question,
          history,
          signal,
          onText,
          onRetry,
        });
        usage = result?.usage;
        outcome = signal.aborted
          ? { kind: 'cancelled' }
          : outcomeFromResult(result);
      } catch (error) {
        outcome = signal.aborted
          ? { kind: 'cancelled' }
          : { kind: 'failed', error: describeError(error), cause: error };
      }
      this.settle(id, outcome);
      return usage ? { ...outcome, usage } : outcome;
    })();

    return { id, done };
  }

  /** Cancels a running request. Settled requests and unknown ids are ignored. */
  abort(id: string): void {
    if (!this.getRunning(id)) return;
    this.controllers.get(id)?.abort();
    this.settle(id, { kind: 'cancelled' });
  }

  removeExchanges(ids: readonly string[]): void {
    const removed = new Set(ids);
    const exchanges = this.snapshot.exchanges.filter(
      (exchange) => !removed.has(exchange.id),
    );
    if (exchanges.length === this.snapshot.exchanges.length) return;
    this.commit({ ...this.snapshot, exchanges });
  }

  /** Cancels running requests and drops history. */
  dispose(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.commit({ exchanges: [], requests: [] });
  }

  private getRunning(id: string): BtwRequest | undefined {
    const request = this.getRequest(id);
    return request?.outcome === null ? request : undefined;
  }

  private settle(id: string, outcome: BtwOutcome): void {
    this.controllers.delete(id);
    const request = this.getRunning(id);
    if (!request) return;

    const exchanges =
      outcome.kind === 'answered'
        ? [
            ...this.snapshot.exchanges,
            { id, question: request.question, response: outcome.response },
          ].slice(-BTW_HISTORY_LIMIT)
        : this.snapshot.exchanges;

    this.commit({
      exchanges,
      requests: pruneSettledRequests(
        this.snapshot.requests.map((entry) =>
          entry.id === id ? { ...entry, outcome, retry: null } : entry,
        ),
      ),
    });
  }

  private updateRequest(id: string, patch: Partial<BtwRequest>): void {
    this.commit({
      ...this.snapshot,
      requests: this.snapshot.requests.map((request) =>
        request.id === id ? { ...request, ...patch } : request,
      ),
    });
  }

  private commit(next: BtwSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function outcomeFromResult(result: BtwRunResult | null): BtwOutcome {
  if (!result) return { kind: 'unavailable' };
  const response = result.text?.trim() ?? '';
  if (response) return { kind: 'answered', response };
  if (result.toolCallName) {
    return { kind: 'tool-call', toolName: result.toolCallName };
  }
  return { kind: 'empty' };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || 'Unknown error';
}

/** Keeps every running request and the newest settled ones. */
function pruneSettledRequests(
  requests: readonly BtwRequest[],
): readonly BtwRequest[] {
  let settledBudget = BTW_HISTORY_LIMIT;
  const kept: BtwRequest[] = [];
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request.outcome === null) {
      kept.push(request);
    } else if (settledBudget > 0) {
      kept.push(request);
      settledBudget -= 1;
    }
  }
  return kept.reverse();
}

const sessions = new WeakMap<
  Config,
  { sessionId: string; session: BtwSession }
>();

/**
 * Returns the /btw session for the config's current session id. A changed id
 * (/clear, /new, resume) disposes the previous session's requests and history.
 */
export function getBtwSession(config: Config): BtwSession {
  const sessionId = config.getSessionId();
  const entry = sessions.get(config);
  if (entry?.sessionId === sessionId) return entry.session;
  entry?.session.dispose();
  const session = new BtwSession(config);
  sessions.set(config, { sessionId, session });
  return session;
}
