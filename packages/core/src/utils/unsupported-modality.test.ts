/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ContentGeneratorConfigSourceKind } from '../core/contentGenerator.js';
import { unsupportedModalityReason } from './unsupported-modality.js';

describe('unsupportedModalityReason', () => {
  it('names the model for every source', () => {
    const sources: ContentGeneratorConfigSourceKind[] = [
      'computed',
      'settings',
      'modelProviders',
    ];
    for (const sourceKind of sources) {
      expect(
        unsupportedModalityReason('image', 'my-model', sourceKind),
      ).toContain("Model 'my-model' does not support image input");
    }
  });

  it('points a name-guessed model at the provider entry', () => {
    const reason = unsupportedModalityReason('image', 'my-model', 'computed');
    expect(reason).toContain('inferred from the model name');
    expect(reason).toContain('"modalities": { "image": true }');
  });

  it('points a settings-declared value at the settings key', () => {
    expect(
      unsupportedModalityReason('image', 'my-model', 'settings'),
    ).toContain('"model.generationConfig.modalities"');
  });

  it('points a provider-declared value at the provider entry', () => {
    expect(
      unsupportedModalityReason('image', 'my-model', 'modelProviders'),
    ).toContain('provider entry\'s "generationConfig.modalities"');
  });

  it('omits the advice when the source is unknown', () => {
    const reason = unsupportedModalityReason('image', 'my-model');
    expect(reason).toBe("Model 'my-model' does not support image input.");
  });
});
