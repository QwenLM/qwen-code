/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-scoped store for /btw side questions.
 *
 * The store owns every side-question request: it starts `runSideQuestion`,
 * accumulates streamed text and retry state, and records a finished answer
 * exactly once. `BtwDialog` only renders store state, so a panel that another
 * dialog replaces neither cancels nor duplicates its request, and reopening
 * `/btw` shows the text that streamed in while the panel was gone.
 *
 * History is transient. It never enters the transcript and is dropped when
 * the session id changes (/clear, /new, resume, branch).
 */

import { randomUUID } from 'node:crypto';
import {
  isAbortError,
  runSideQuestion,
  type QueryEvent,
  type SideQuestionParams,
  type SideQuestionResult,
} from '@qwen-code/core';

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
  readonly status: number | null;
  /** Absolute time of the next attempt, so a panel mounted mid-wait counts down correctly. */
  readonly retryAt: number;
}

export type BtwOutcome =
  | { readonly kind: 'answered'; readonly response: string }
  | { readonly kind: 'synthetic'; readonly response: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed'; readonly error: string }
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

export type BtwAskParams = Omit<
  SideQuestionParams,
  'question' | 'history' | 'signal' | 'onEvent'
>;

type SideQuestionRunner = (
  params: SideQuestionParams,
) => Promise<SideQuestionResult>;

const FAILED_RESPONSE_FALLBACK = 'Failed to get response';

export class BtwHistoryStore {
  private snapshot: BtwSnapshot = { exchanges: [], requests: [] };
  private sessionId: string | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  /** Offset in `streamingText` where the request's current model call began. */
  private readonly requestTextStart = new Map<string, number>();

  constructor(
    private readonly runner: SideQuestionRunner = runSideQuestion,
    private readonly now: () => number = Date.now,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): BtwSnapshot => this.snapshot;

  /**
   * Associates the store with the active session. Switching to a different
   * session cancels running requests and drops history.
   */
  bindSession(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === this.sessionId) return;
    const previous = this.sessionId;
    this.sessionId = sessionId;
    if (previous !== undefined) {
      this.reset();
    }
  }

  /** The newest running request, else the newest answered exchange. */
  getReopenTargetId(): string | undefined {
    const running = this.snapshot.requests.findLast(
      (request) => request.outcome === null,
    );
    return running?.id ?? this.snapshot.exchanges.at(-1)?.id;
  }

  ask(question: string, params: BtwAskParams): string {
    const id = randomUUID();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.requestTextStart.set(id, 0);

    const history = this.snapshot.exchanges.map((exchange) => ({
      question: exchange.question,
      response: exchange.response,
    }));
    this.commit({
      ...this.snapshot,
      requests: [
        ...this.snapshot.requests,
        { id, question, streamingText: '', retry: null, outcome: null },
      ],
    });

    let pending: Promise<SideQuestionResult>;
    try {
      pending = this.runner({
        ...params,
        question,
        history,
        signal: controller.signal,
        onEvent: (event) => this.handleEvent(id, event),
      });
    } catch (error) {
      pending = Promise.reject(error);
    }

    void pending.then(
      (result) => this.settle(id, outcomeFromResult(result)),
      (error: unknown) =>
        this.settle(
          id,
          controller.signal.aborted || isAbortError(error)
            ? { kind: 'cancelled' }
            : { kind: 'failed', error: describeError(error) },
        ),
    );

    return id;
  }

  /** Cancels a running request. Settled requests and unknown ids are ignored. */
  abort(id: string): void {
    const request = this.findRequest(id);
    if (!request || request.outcome !== null) return;
    this.controllers.get(id)?.abort();
    this.forget(id);
    this.updateRequest(id, {
      outcome: { kind: 'cancelled' },
      streamingText: '',
      retry: null,
    });
  }

  removeExchanges(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const removed = new Set(ids);
    const exchanges = this.snapshot.exchanges.filter(
      (exchange) => !removed.has(exchange.id),
    );
    if (exchanges.length === this.snapshot.exchanges.length) return;
    this.commit({ ...this.snapshot, exchanges });
  }

  reset(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.requestTextStart.clear();
    this.commit({ exchanges: [], requests: [] });
  }

  private handleEvent(id: string, event: QueryEvent): void {
    const request = this.findRequest(id);
    if (!request || request.outcome !== null) return;

    switch (event.type) {
      case 'request_start':
        this.requestTextStart.set(id, request.streamingText.length);
        if (request.retry) {
          this.updateRequest(id, { retry: null });
        }
        return;
      case 'result_text_reset':
        this.updateRequest(id, {
          streamingText: this.textBeforeCurrentCall(id, request),
        });
        return;
      case 'stream_event': {
        const delta = extractTextDelta(event.event);
        if (!delta) return;
        this.updateRequest(id, {
          streamingText: request.streamingText + delta,
          retry: null,
        });
        return;
      }
      case 'system': {
        if (event.subtype !== 'api_retry') return;
        const retry = readRetryEvent(event, this.now());
        if (!retry) return;
        // A retried call streams its answer again from the start.
        this.updateRequest(id, {
          streamingText: this.textBeforeCurrentCall(id, request),
          retry,
        });
        return;
      }
      default:
        return;
    }
  }

  private settle(id: string, outcome: BtwOutcome): void {
    this.forget(id);
    const request = this.findRequest(id);
    if (!request || request.outcome !== null) return;

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
          entry.id === id
            ? { ...entry, outcome, streamingText: '', retry: null }
            : entry,
        ),
      ),
    });
  }

  private textBeforeCurrentCall(id: string, request: BtwRequest): string {
    const start = this.requestTextStart.get(id) ?? 0;
    return request.streamingText.slice(0, start);
  }

  private findRequest(id: string): BtwRequest | undefined {
    return this.snapshot.requests.find((request) => request.id === id);
  }

  private updateRequest(id: string, patch: Partial<BtwRequest>): void {
    this.commit({
      ...this.snapshot,
      requests: this.snapshot.requests.map((request) =>
        request.id === id ? { ...request, ...patch } : request,
      ),
    });
  }

  private forget(id: string): void {
    this.controllers.delete(id);
    this.requestTextStart.delete(id);
  }

  private commit(next: BtwSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function outcomeFromResult(result: SideQuestionResult): BtwOutcome {
  const response = result.textContent.trim();
  if (!response) return { kind: 'empty' };
  return result.synthetic
    ? { kind: 'synthetic', response }
    : { kind: 'answered', response };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || FAILED_RESPONSE_FALLBACK;
}

function extractTextDelta(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { type, delta } = raw as {
    type?: unknown;
    delta?: { type?: unknown; text?: unknown };
  };
  if (
    type === 'content_block_delta' &&
    delta?.type === 'text_delta' &&
    typeof delta.text === 'string'
  ) {
    return delta.text;
  }
  return undefined;
}

function readRetryEvent(event: object, now: number): BtwRetryState | null {
  const { attempt, max_retries, retry_delay_ms, error_status } = event as {
    attempt?: unknown;
    max_retries?: unknown;
    retry_delay_ms?: unknown;
    error_status?: unknown;
  };
  if (
    typeof attempt !== 'number' ||
    typeof max_retries !== 'number' ||
    typeof retry_delay_ms !== 'number'
  ) {
    return null;
  }
  return {
    attempt,
    maxRetries: max_retries,
    status: typeof error_status === 'number' ? error_status : null,
    retryAt: now + retry_delay_ms,
  };
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

export const btwHistoryStore = new BtwHistoryStore();
