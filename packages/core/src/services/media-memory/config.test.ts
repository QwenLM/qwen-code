/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  OMNI_MEMORY_RECALL_KINDS,
  OmniMemoryConfigError,
  normalizeOmniMemoryConfig,
} from './config.js';

describe('normalizeOmniMemoryConfig', () => {
  it('returns the full defaults for undefined / empty input', () => {
    expect(normalizeOmniMemoryConfig(undefined)).toEqual(
      DEFAULT_OMNI_MEMORY_CONFIG,
    );
    expect(normalizeOmniMemoryConfig({})).toEqual(DEFAULT_OMNI_MEMORY_CONFIG);
  });

  it('never returns the shared default object references', () => {
    const normalized = normalizeOmniMemoryConfig(undefined);
    expect(normalized.recall.kinds).not.toBe(
      DEFAULT_OMNI_MEMORY_CONFIG.recall.kinds,
    );
    expect(normalized.recall.sideQuery).not.toBe(
      DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery,
    );
  });

  it('merges per-key overrides over the defaults', () => {
    const normalized = normalizeOmniMemoryConfig({
      collection: { maxInlineTextBytes: 1024 },
      recall: {
        mode: 'sideQuery',
        maxEntries: 6,
        kinds: ['derived_media'],
        includeHistoricalVersions: true,
        active: { maxFilesPerCall: 2 },
        sideQuery: { model: 'qwen3.5-omni-plus', maxSelectedEntries: 3 },
      },
    });
    expect(normalized.collection.maxInlineTextBytes).toBe(1024);
    expect(normalized.recall).toMatchObject({
      mode: 'sideQuery',
      maxEntries: 6,
      kinds: ['derived_media'],
      includeHistoricalVersions: true,
      active: { maxFilesPerCall: 2 },
    });
    expect(normalized.recall.sideQuery).toMatchObject({
      model: 'qwen3.5-omni-plus',
      maxSelectedEntries: 3,
      // Untouched keys keep their defaults.
      timeoutMs: 30000,
      maxAttempts: 1,
    });
    // Unset scalar keeps its default.
    expect(normalized.recall.maxTextChars).toBe(24000);
  });

  it('rejects unknown keys at every level', () => {
    for (const raw of [
      { collection: { maxInlineBytes: 1 } },
      { recall: { maxEntry: 1 } },
      { recall: { active: { maxFiles: 1 } } },
      { recall: { sideQuery: { timeout: 1 } } },
    ]) {
      expect(() => normalizeOmniMemoryConfig(raw)).toThrow(
        OmniMemoryConfigError,
      );
    }
  });

  it('rejects non-object sections', () => {
    expect(() => normalizeOmniMemoryConfig({ collection: 5 })).toThrow(
      OmniMemoryConfigError,
    );
    expect(() => normalizeOmniMemoryConfig({ recall: [] })).toThrow(
      OmniMemoryConfigError,
    );
  });

  it('rejects invalid scalar values', () => {
    for (const raw of [
      { collection: { maxInlineTextBytes: 0 } },
      { collection: { maxInlineTextBytes: 1.5 } },
      { recall: { maxEntries: -1 } },
      { recall: { maxTextChars: '24000' } },
      { recall: { mode: 'passive' } },
      { recall: { includeHistoricalVersions: 'yes' } },
      { recall: { active: { maxFilesPerCall: 0 } } },
      { recall: { sideQuery: { maxAttempts: 0 } } },
      { recall: { sideQuery: { model: '' } } },
      { recall: { sideQuery: { model: 42 } } },
    ]) {
      expect(() => normalizeOmniMemoryConfig(raw)).toThrow(
        OmniMemoryConfigError,
      );
    }
  });

  it('accepts model: null as "use the session model"', () => {
    const normalized = normalizeOmniMemoryConfig({
      recall: { sideQuery: { model: null } },
    });
    expect(normalized.recall.sideQuery.model).toBeNull();
  });

  it('validates the kinds array: non-empty, known, no duplicates, wholesale replace', () => {
    expect(() => normalizeOmniMemoryConfig({ recall: { kinds: [] } })).toThrow(
      OmniMemoryConfigError,
    );
    expect(() =>
      normalizeOmniMemoryConfig({ recall: { kinds: ['nonsense'] } }),
    ).toThrow(OmniMemoryConfigError);
    expect(() =>
      normalizeOmniMemoryConfig({
        recall: { kinds: ['metadata', 'metadata'] },
      }),
    ).toThrow(OmniMemoryConfigError);
    const normalized = normalizeOmniMemoryConfig({
      recall: { kinds: ['execution'] },
    });
    expect(normalized.recall.kinds).toEqual(['execution']);
    expect(OMNI_MEMORY_RECALL_KINDS).toContain('execution');
  });

  it('enforces cross-field budget ordering', () => {
    // maxSelectedEntries must not exceed maxEntries.
    expect(() =>
      normalizeOmniMemoryConfig({
        recall: { maxEntries: 4, sideQuery: { maxSelectedEntries: 5 } },
      }),
    ).toThrow(OmniMemoryConfigError);
    // maxEntries must not exceed maxCandidateEntries.
    expect(() =>
      normalizeOmniMemoryConfig({
        recall: { maxEntries: 200 },
      }),
    ).toThrow(OmniMemoryConfigError);
    // A consistent triple passes.
    const normalized = normalizeOmniMemoryConfig({
      recall: {
        maxEntries: 20,
        sideQuery: { maxCandidateEntries: 40, maxSelectedEntries: 20 },
      },
    });
    expect(normalized.recall.maxEntries).toBe(20);
  });
});
