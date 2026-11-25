/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  testProviderModelResolution,
  testCompressionConfig,
  testModelProviderManager,
} from './provider-test-helpers.js';

import { testRequestConfig } from '../test-utils/model-resolution.js';

/**
 * CTX70 — Multi-stage compression pipeline ordering.
 *
 * The pipeline doc-comment (pipeline.ts:85-92) promises a specific stage
 * order. This test mocks each stage module and asserts the call sequence
 * so future refactors can't silently reorder stages.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompressionStatus } from '../core/turn-events.js';
import type { Message } from './message-types.js';
import { makeAssistant, makeUser } from './test-helpers.js';
import { DEFAULT_COMPRESSION_CONFIG } from './config.js';
import { createEmptyCompressionPipelineState } from './state-store.js';
import type { CompressionStateStore } from './state-store.js';

const { callOrder } = vi.hoisted(() => ({
  callOrder: [] as string[],
}));

vi.mock('./tool-result-budget.js', async () => {
  const actual = await vi.importActual<
    typeof import('./tool-result-budget.js')
  >('./tool-result-budget.js');
  return {
    ...actual,
    applyToolResultBudget: vi.fn(async (history: readonly Message[]) => {
      callOrder.push('applyToolResultBudget');
      return [...history];
    }),
  };
});

vi.mock('./auto-compact.js', async () => {
  const actual =
    await vi.importActual<typeof import('./auto-compact.js')>(
      './auto-compact.js',
    );
  return {
    ...actual,
    runAutoCompactStage: vi.fn(async () => {
      callOrder.push('runAutoCompactStage');
      return {
        newHistory: null,
        info: {
          compressionStatus: CompressionStatus.NOOP,
          originalTokenCount: 0,
          newTokenCount: 0,
        },
      };
    }),
  };
});

// post-compact-restore was retired in favor of `finalizePostCompact()` invoked
// via the onCompressionCompleted hook (see pipeline.ts comment near
// `restoredResult`). The pipeline no longer calls a restore stage of its own,
// so this test no longer expects that step in the call order.

vi.mock('./cleanup.js', async () => {
  const actual =
    await vi.importActual<typeof import('./cleanup.js')>('./cleanup.js');
  return {
    ...actual,
    runCompressionCleanup: vi.fn(async () => {
      callOrder.push('runCompressionCleanup');
    }),
  };
});

vi.mock('./boundary.js', async () => {
  const actual =
    await vi.importActual<typeof import('./boundary.js')>('./boundary.js');
  return {
    ...actual,
    findCompressionBoundary: vi.fn((history: readonly Message[]) => {
      callOrder.push('findCompressionBoundary');
      return {
        contents: [...history],
        prefixContents: [] as Message[],
      };
    }),
  };
});

import { CompressionPipeline, type CompressOptions } from './pipeline.js';

function makeHistory(): Message[] {
  return [
    makeUser([{ type: 'text' as const, text: 'hello' }]),
    makeAssistant([{ type: 'text' as const, text: 'hi' }]),
  ];
}

function makeConfig(): CompressOptions['config'] {
  return {
    ...testRequestConfig(),
    ...testCompressionConfig(),
    getCompressionConfig: () => DEFAULT_COMPRESSION_CONFIG,
    getSessionId: () => 'session-order',
    getActiveSessionTranscriptPath: () => '/tmp/session-order.jsonl',
    getTargetDir: () => '/tmp/order-test',
  } as unknown as CompressOptions['config'];
}

describe('CompressionPipeline stage ordering [CTX70]', () => {
  beforeEach(() => {
    callOrder.length = 0;
  });

  it('runs stages in the documented order: boundary → budget → autocompact → cleanup', async () => {
    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    } as unknown as CompressionStateStore;

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore,
    );

    await pipeline.compress(makeHistory(), {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-order',
      force: true,
      config: makeConfig(),
    });

    expect(callOrder).toEqual([
      'findCompressionBoundary',
      'applyToolResultBudget',
      'runAutoCompactStage',
      'runCompressionCleanup',
    ]);
  });

  it('short-circuits before budget/autocompact when boundary has no model turn', async () => {
    const state = createEmptyCompressionPipelineState();
    const stateStore = {
      getState: vi.fn(() => state),
      saveState: vi.fn(),
    } as unknown as CompressionStateStore;

    const pipeline = new CompressionPipeline(
      { modelProviderManager: testModelProviderManager(), target: 'main' },
      stateStore,
    );

    // User-only history: boundary.contents has no assistant role, so the
    // pipeline must exit immediately after boundary detection (pipeline.ts
    // lines 142-147), without running downstream stages.
    await pipeline.compress(
      [makeUser([{ type: 'text' as const, text: 'only user' }])],
      {
        modelResolution: testProviderModelResolution('test-model', {}),
        promptId: 'prompt-nomodel',
        force: true,
        config: makeConfig(),
      },
    );

    expect(callOrder).toEqual(['findCompressionBoundary']);
  });
});
