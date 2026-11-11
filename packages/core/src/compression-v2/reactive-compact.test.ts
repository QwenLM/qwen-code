/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { testProviderModelResolution } from './provider-test-helpers.js';

import { describe, expect, it, vi } from 'vitest';
import type { CompressionPipeline } from './pipeline.js';
import { tryReactiveCompact } from './reactive-compact.js';
import { emptySnapshotSource } from '../test-utils/listed-model.js';
import { makeUser } from './test-helpers.js';
import type { Message } from '../protocol/transcript/message.js';
import { ModelInferenceError } from '../provider/modelInferenceError.js';

function createParams(
  compress: CompressionPipeline['compress'],
  abortSignal?: AbortSignal,
): Parameters<typeof tryReactiveCompact>[0] {
  const requestPrefixMessages: readonly Message[] = [
    makeUser([{ type: 'text', text: 'exact parent request prefix' }]),
  ];
  return {
    history: [makeUser([{ type: 'text', text: 'compact this history' }])],
    compressionPipeline: {
      compress,
    } as CompressionPipeline,
    compressOptions: {
      modelResolution: testProviderModelResolution('test-model', {}),
      promptId: 'prompt-reactive',
      requestPrefixMessages,
      config: emptySnapshotSource,
      abortSignal,
    } as Parameters<typeof tryReactiveCompact>[0]['compressOptions'],
  };
}

describe('tryReactiveCompact cancellation', () => {
  it('preserves the exact parent request prefix', async () => {
    const compress = vi.fn().mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 1,
        newTokenCount: 1,
        compressionStatus: 'noop',
      },
    });

    await tryReactiveCompact(createParams(compress));

    expect(compress).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        force: true,
        trigger: 'reactive',
        requestPrefixMessages: [expect.objectContaining({ type: 'user' })],
      }),
    );
  });

  it.each([
    Object.assign(new Error('aborted'), { name: 'AbortError' }),
    new Error('Operation cancelled by user'),
  ])('rethrows compression cancellation', async (cancellationError) => {
    const compress = vi.fn().mockRejectedValue(cancellationError);

    await expect(tryReactiveCompact(createParams(compress))).rejects.toBe(
      cancellationError,
    );
  });

  it('rethrows when the parent signal was aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new Error('pipeline stopped');
    const compress = vi.fn().mockRejectedValue(error);

    await expect(
      tryReactiveCompact(createParams(compress, controller.signal)),
    ).rejects.toBe(error);
  });

  it('rethrows Qoder paid confirmation errors', async () => {
    const error = new ModelInferenceError('paid confirmation required', {
      kind: 'quota_exhausted',
      phase: 'before_output',
      qoderApiError: {
        source: 'qoder_api',
        subCode: 'MODEL_PAID_CONFIRM_REQUIRED',
      },
    });
    const compress = vi.fn().mockRejectedValue(error);

    await expect(tryReactiveCompact(createParams(compress))).rejects.toBe(
      error,
    );
  });

  it('keeps ordinary compression failures as a nullable recovery result', async () => {
    const compress = vi
      .fn()
      .mockRejectedValue(new Error('temporary compression failure'));

    await expect(
      tryReactiveCompact(createParams(compress)),
    ).resolves.toBeNull();
  });
});
