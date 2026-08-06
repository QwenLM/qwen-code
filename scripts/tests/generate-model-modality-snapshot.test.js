/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../generate-model-modality-snapshot.js';

describe('buildSnapshot', () => {
  it('keeps compact modality arrays and provider lookup metadata', () => {
    expect(
      buildSnapshot({
        provider: {
          api: 'https://provider.example/v1',
          env: ['PROVIDER_API_KEY'],
          models: { compact: ['text', 'image'] },
        },
      }).provider,
    ).toEqual({
      api: 'https://provider.example/v1',
      env: ['PROVIDER_API_KEY'],
      models: { compact: ['text', 'image'] },
    });
  });

  it('keeps attachment-only model metadata', () => {
    expect(
      buildSnapshot({
        provider: {
          models: {
            attachment: { attachment: true },
          },
        },
      }).provider.models.attachment,
    ).toEqual({ attachment: true });
  });

  it('handles reserved provider and model ids without prototype mutation', () => {
    const catalog = JSON.parse(
      '{"__proto__":{"models":{"__proto__":{"modalities":{"input":["text","image"]}}}}}',
    );
    const snapshot = buildSnapshot(catalog);

    expect(Object.keys(snapshot)).toEqual(['__proto__']);
    expect(snapshot['__proto__'].models['__proto__']).toEqual([
      'text',
      'image',
    ]);
  });

  it('rejects an empty result before it can replace the snapshot', () => {
    expect(() => buildSnapshot({ provider: { models: {} } })).toThrow(
      'models.dev returned no valid model metadata',
    );
  });
});
