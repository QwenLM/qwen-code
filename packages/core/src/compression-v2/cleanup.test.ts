/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  testProviderModelResolution,
  testModelProviderManager,
} from './provider-test-helpers.js';

import { describe, expect, it } from 'vitest';
import { CompressionStatus } from '../core/turn-events.js';
import { runCompressionCleanup } from './cleanup.js';
import { createEmptyCompressionPipelineState } from './state-store.js';
import type {
  CompressionPipelineResult,
  CompressionStageContext,
} from './types.js';

function createContext(
  trigger: CompressionStageContext['input']['trigger'] = 'auto',
): CompressionStageContext {
  return {
    input: {
      modelProviderManager: testModelProviderManager(),
      modelResolution: testProviderModelResolution('test-model'),
      history: [],
      requestPrefixMessages: [],
      promptTokenCount: 0,
      promptId: 'prompt-1',
      force: false,
      trigger,
      autoCompactTracking: { consecutiveFailures: 0 },
      config: {} as CompressionStageContext['input']['config'],
      target: 'main',
      rootSessionId: 'root-session-main',
      sessionScopeId: 'session-main',
    },
    state: createEmptyCompressionPipelineState(),
    boundary: {
      startIndex: 0,
      prefixContents: [],
      contents: [],
      source: 'initial_history',
    },
    fullHistory: [],
    workingHistory: [],
  };
}

function createResult(
  compressionStatus: CompressionStatus,
  failureReason?: string,
): CompressionPipelineResult {
  return {
    newHistory: null,
    info: {
      originalTokenCount: 100,
      newTokenCount: 80,
      compressionStatus,
      ...(failureReason !== undefined && { failureReason }),
    },
  };
}

describe('runCompressionCleanup', () => {
  it('does not retain a circuit-breaker strike for an access preparation failure', async () => {
    const context = createContext();
    for (let attempt = 0; attempt < 4; attempt++) {
      await runCompressionCleanup(
        createResult(
          CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
          'provider_access',
        ),
        context,
      );
    }
    expect(context.input.autoCompactTracking).toEqual({
      consecutiveFailures: 0,
    });
  });
  it('increments consecutive failures for compression failures', async () => {
    const context = createContext();

    await runCompressionCleanup(
      createResult(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY),
      context,
    );

    expect(context.input.autoCompactTracking.consecutiveFailures).toBe(1);
    expect(context.input.autoCompactTracking.lastFailureReason).toBe(
      'compression_failed_empty_summary',
    );
  });

  it('increments consecutive failures for compaction model request failures', async () => {
    const context = createContext();

    await runCompressionCleanup(
      createResult(CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST),
      context,
    );

    expect(context.input.autoCompactTracking.consecutiveFailures).toBe(1);
    expect(context.input.autoCompactTracking.lastFailureReason).toBe(
      'compression_failed_model_request',
    );
  });

  it.each(['rate_limited', 'model_queued', 'network_error', 'server_error'])(
    'counts exhausted transient model failure %s once',
    async (failureReason) => {
      const context = createContext();

      await runCompressionCleanup(
        createResult(
          CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
          failureReason,
        ),
        context,
      );

      expect(context.input.autoCompactTracking).toEqual({
        consecutiveFailures: 1,
        lastFailureReason: failureReason,
      });
    },
  );

  it.each([
    ['quota_exhausted', 'quota_exhausted'],
    ['auth_error', 'auth_error'],
  ] as const)(
    'blocks the current query for %s without consuming a strike',
    async (failureReason, blockedReason) => {
      const context = createContext();

      await runCompressionCleanup(
        createResult(
          CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
          failureReason,
        ),
        context,
      );

      expect(context.input.autoCompactTracking).toEqual({
        consecutiveFailures: 0,
        lastFailureReason: failureReason,
        blockedReason,
      });
    },
  );

  it('blocks the current query for local token-count errors without a strike', async () => {
    const context = createContext();

    await runCompressionCleanup(
      createResult(CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR),
      context,
    );

    expect(context.input.autoCompactTracking.consecutiveFailures).toBe(0);
    expect(context.input.autoCompactTracking.blockedReason).toBe('local_error');
  });

  it('does not count cancellation', async () => {
    const context = createContext();

    await runCompressionCleanup(
      createResult(
        CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
        'cancelled',
      ),
      context,
    );

    expect(context.input.autoCompactTracking).toEqual({
      consecutiveFailures: 0,
    });
  });

  it.each(['manual', 'reactive'] as const)(
    'does not count %s compaction failures',
    async (trigger) => {
      const context = createContext(trigger);

      await runCompressionCleanup(
        createResult(
          CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
          'rate_limited',
        ),
        context,
      );

      expect(context.input.autoCompactTracking).toEqual({
        consecutiveFailures: 0,
      });
    },
  );

  it('resets consecutive failures after a successful compaction outcome', async () => {
    const context = createContext();
    context.input.autoCompactTracking.consecutiveFailures = 2;
    context.input.autoCompactTracking.blockedReason = 'quota_exhausted';
    context.input.autoCompactTracking.lastFailureReason = 'quota_exhausted';

    await runCompressionCleanup(
      createResult(CompressionStatus.COMPRESSED),
      context,
    );

    expect(context.input.autoCompactTracking.consecutiveFailures).toBe(0);
    expect(context.input.autoCompactTracking.lastFailureReason).toBeUndefined();
  });
});
