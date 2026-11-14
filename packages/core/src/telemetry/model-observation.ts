/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { getErrorStatus, getErrorType } from '../utils/errors.js';

export type ModelObservationSource = 'main' | 'hook' | 'compression';
export type ModelObservationOutcome =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'interrupted';
export type ModelObservationFailure =
  | 'http'
  | 'transport'
  | 'timeout'
  | 'other';

export interface ModelInvocationObservation {
  readonly executionId: string;
  readonly source: ModelObservationSource;
  readonly model: string;
  readonly authType?: string;
  readonly at: number;
  readonly outcome: ModelObservationOutcome;
  readonly durationMs: number;
  readonly usage?: GenerateContentResponseUsageMetadata;
  readonly ttftMs?: number;
  readonly generationMs?: number;
  readonly failureKind: ModelObservationFailure | null;
  readonly statusCode: number | null;
  readonly backoffRetryOrdinal: number;
}

export interface ModelObservationScope {
  readonly sessionId: string;
  readonly source: ModelObservationSource;
  readonly observe: (observation: ModelInvocationObservation) => void;
  readonly observationFailed: () => void;
}

const scopes = new AsyncLocalStorage<ModelObservationScope>();

export function withModelObservationScope<T>(
  scope: ModelObservationScope,
  run: () => T,
): T {
  return scopes.run(scope, run);
}

export function withModelObservationSource<T>(
  source: ModelObservationSource,
  run: () => T,
): T {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, source }, run) : run();
}

function count(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)))
    : 0;
}

/** One invocation owns this closure, including an iterator never consumed. */
export function startModelInvocationObservation(input: {
  sessionId: string;
  executionId: string;
  model: string;
  authType?: string;
  startedAt: number;
  retryAttempt: number;
}) {
  const scope = scopes.getStore();
  if (!scope || scope.sessionId !== input.sessionId) return undefined;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let usage: GenerateContentResponseUsageMetadata | undefined;
  let model = input.model;
  let ttftMs: number | undefined;
  let generationMs: number | undefined;
  const failed = () => {
    try {
      scope.observationFailed();
    } catch {
      // Observation cannot fail a provider invocation.
    }
  };
  const finish = (outcome: ModelObservationOutcome, error?: unknown) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    const status = error === undefined ? undefined : getErrorStatus(error);
    const statusCode =
      typeof status === 'number' && status >= 100 && status <= 599
        ? status
        : null;
    const errorType = error === undefined ? '' : getErrorType(error);
    const failureKind: ModelObservationFailure | null =
      outcome !== 'error'
        ? null
        : statusCode !== null
          ? 'http'
          : /timeout/iu.test(errorType)
            ? 'timeout'
            : /network|fetch|connect|socket|transport/iu.test(errorType)
              ? 'transport'
              : 'other';
    try {
      scope.observe({
        executionId: input.executionId,
        source: scope.source,
        model,
        authType: input.authType,
        at: count(Date.now()),
        outcome,
        durationMs: count(Date.now() - input.startedAt),
        ...(usage ? { usage } : {}),
        ...(ttftMs === undefined ? {} : { ttftMs }),
        ...(generationMs === undefined ? {} : { generationMs }),
        failureKind,
        statusCode,
        backoffRetryOrdinal: count(input.retryAttempt - 1),
      });
    } catch {
      failed();
    }
  };
  return {
    finish,
    update(
      reportedUsage?: GenerateContentResponseUsageMetadata,
      reportedModel?: string,
      timing?: { ttftMs?: number; generationMs?: number },
    ) {
      if (ended) return;
      if (reportedUsage) {
        usage = {};
        for (const key of [
          'promptTokenCount',
          'candidatesTokenCount',
          'totalTokenCount',
          'cachedContentTokenCount',
          'thoughtsTokenCount',
        ] as const) {
          const value = reportedUsage[key];
          if (
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0
          )
            usage[key] = value;
        }
      }
      if (reportedModel) model = reportedModel;
      if (timing?.ttftMs !== undefined) ttftMs = count(timing.ttftMs);
      if (timing?.generationMs !== undefined)
        generationMs = count(timing.generationMs);
    },
    touchStream() {
      if (ended) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish('interrupted'), 5 * 60_000);
      timer.unref();
    },
  };
}
