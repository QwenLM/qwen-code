/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { defaultModalities } from './modalityDefaults.js';

vi.mock('../models/model-catalog.js', () => {
  const entries: Record<string, { modalities?: Record<string, boolean> }> = {
    'qwen-catalog-vision': { modalities: { image: true } },
    'qwen3-vl-catalog': { modalities: { pdf: true } },
    'catalog-only-model': { modalities: { audio: true } },
    'catalog-vision-model': { modalities: { image: true } },
  };
  return { lookupModelCatalog: (model: string) => entries[model] };
});

describe('models.dev catalog', () => {
  it('adds catalog modalities to a text-only family', () => {
    expect(defaultModalities('qwen-catalog-vision')).toEqual({ image: true });
  });

  it('merges catalog and regex modalities instead of replacing them', () => {
    expect(defaultModalities('qwen3-vl-catalog')).toEqual({
      image: true,
      video: true,
      pdf: true,
    });
  });

  it('uses the catalog alone for a model no family pattern matches', () => {
    expect(defaultModalities('catalog-only-model')).toEqual({ audio: true });
    expect(defaultModalities('unknown-model')).toEqual({});
  });

  it('looks the catalog up by normalized id', () => {
    expect(defaultModalities('provider/Catalog-Vision-Model:free')).toEqual({
      image: true,
    });
  });
});
