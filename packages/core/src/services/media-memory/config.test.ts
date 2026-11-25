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
    expect(normalized.recall.active).not.toBe(
      DEFAULT_OMNI_MEMORY_CONFIG.recall.active,
    );

    // The defaults are a module-global that every later normalization in
    // the process reads: an aliased nested object turns one session's
    // override into the baseline for the next config load (and for the
    // Config accessors already holding the object), which is how a
    // per-session budget becomes a permanent one nobody configured.
    normalized.recall.active.maxFilesPerCall = 99;
    normalized.recall.sideQuery.maxAttempts = 99;
    normalized.recall.kinds.length = 0;
    expect(DEFAULT_OMNI_MEMORY_CONFIG.recall.active.maxFilesPerCall).toBe(8);
    expect(DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery.maxAttempts).toBe(1);
    expect(DEFAULT_OMNI_MEMORY_CONFIG.recall.kinds).toEqual([
      ...OMNI_MEMORY_RECALL_KINDS,
    ]);
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
      // Root level too: a typo'd section would otherwise silently discard
      // the WHOLE configuration and run defaults (active mode) while the
      // operator believes sideQuery is configured.
      { recalll: { mode: 'sideQuery' } },
      { collection: {}, memory: {} },
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

  it('rejects a non-object root', () => {
    expect(() => normalizeOmniMemoryConfig(5 as never)).toThrow(
      OmniMemoryConfigError,
    );
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

  it('accepts an explicit mode: "active" override', () => {
    // Every accepted value of a startup-fatal enum needs its own witness:
    // writing the default out explicitly is the most common thing an
    // operator does when documenting a settings file, and rejecting it
    // would abort the session over configuration that changes nothing.
    const normalized = normalizeOmniMemoryConfig({
      recall: { mode: 'active' },
    });
    expect(normalized.recall.mode).toBe('active');
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

  it('validates the budget ordering against the DEFAULTED siblings', () => {
    // The ordering holds over the EFFECTIVE configuration, not over the
    // keys the operator happened to write: lowering maxEntries alone
    // leaves the default selector budget (12) able to pick more entries
    // than recall will ever return, so the selector's picks would be
    // silently dropped mid-request. Fail loud at startup instead.
    expect(() =>
      normalizeOmniMemoryConfig({ recall: { maxEntries: 6 } }),
    ).toThrow(OmniMemoryConfigError);
    // Same in the other direction: shrinking the manifest below the
    // default maxEntries would have recall return entries the selector was
    // never shown.
    expect(() =>
      normalizeOmniMemoryConfig({
        recall: { sideQuery: { maxCandidateEntries: 8 } },
      }),
    ).toThrow(OmniMemoryConfigError);
  });

  it('allows the budgets to be exactly equal at both boundaries', () => {
    // The bounds are "must not exceed", not "must be smaller": a session
    // that selects, returns, and shows the same number of entries is the
    // tightest legal configuration, and rejecting it would make the
    // strictest sensible setting unusable.
    const normalized = normalizeOmniMemoryConfig({
      recall: {
        maxEntries: 12,
        sideQuery: { maxCandidateEntries: 12, maxSelectedEntries: 12 },
      },
    });
    expect(normalized.recall).toMatchObject({
      maxEntries: 12,
      sideQuery: expect.objectContaining({
        maxCandidateEntries: 12,
        maxSelectedEntries: 12,
      }),
    });
  });
});
