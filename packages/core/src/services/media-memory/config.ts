/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPlainRecord } from '../../omni/policy/types.js';

/**
 * Startup normalization of `omni.memory` (memory design M §9). Raw
 * settings enter, a fully defaulted and validated
 * {@link NormalizedOmniMemoryConfig} leaves; any violation throws
 * {@link OmniMemoryConfigError} and MUST abort startup — mirroring the
 * `omni.processing` stance (S4): a mis-configured budget must fail loud,
 * not silently fall back.
 */

/** A configuration error in `omni.memory.*`. Startup-fatal. */
export class OmniMemoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmniMemoryConfigError';
  }
}

/** Entry kinds recall can surface (M §8). */
export const OMNI_MEMORY_RECALL_KINDS = [
  'metadata',
  'derived_media',
  'policy_result',
  'execution',
] as const;
export type OmniMemoryRecallKind = (typeof OMNI_MEMORY_RECALL_KINDS)[number];

export interface NormalizedOmniMemoryCollection {
  /** Upper bound for `inlineText` persisted on an entry; longer text is
   * truncated (the promoted artifact keeps the full content). */
  maxInlineTextBytes: number;
}

export interface NormalizedOmniMemorySideQuery {
  /** Selector model; null = the session's active model. */
  model: string | null;
  timeoutMs: number;
  maxCandidateEntries: number;
  maxSelectedEntries: number;
  maxAttempts: number;
}

export interface NormalizedOmniMemoryRecall {
  /** Mutually exclusive exposure (M §8.1): 'active' registers the recall
   * tool; 'sideQuery' runs the passive selector before the main request. */
  mode: 'active' | 'sideQuery';
  maxEntries: number;
  maxTextChars: number;
  kinds: OmniMemoryRecallKind[];
  includeHistoricalVersions: boolean;
  active: { maxFilesPerCall: number };
  sideQuery: NormalizedOmniMemorySideQuery;
}

export interface NormalizedOmniMemoryConfig {
  collection: NormalizedOmniMemoryCollection;
  recall: NormalizedOmniMemoryRecall;
}

/** Structural view of the Config accessor (same pattern as
 * `OmniProcessingConfigView`): a config without the accessor — stub
 * configs, embedders skipping initialize — reads as "memory off". */
export interface OmniMemoryConfigView {
  getOmniMemoryConfig?: () => NormalizedOmniMemoryConfig | undefined;
}

/** Raw inputs to normalization, as threaded from settings
 * (`omni.memory.collection` / `omni.memory.recall`). */
export interface RawOmniMemorySettings {
  collection?: unknown;
  recall?: unknown;
}

/** M §9 defaults. */
export const DEFAULT_OMNI_MEMORY_CONFIG: NormalizedOmniMemoryConfig = {
  collection: { maxInlineTextBytes: 65536 },
  recall: {
    mode: 'active',
    maxEntries: 12,
    maxTextChars: 24000,
    kinds: [...OMNI_MEMORY_RECALL_KINDS],
    includeHistoricalVersions: false,
    active: { maxFilesPerCall: 8 },
    sideQuery: {
      model: null,
      timeoutMs: 30000,
      maxCandidateEntries: 100,
      maxSelectedEntries: 12,
      maxAttempts: 1,
    },
  },
};

const COLLECTION_KEYS = new Set(['maxInlineTextBytes']);
const RECALL_KEYS = new Set([
  'mode',
  'maxEntries',
  'maxTextChars',
  'kinds',
  'includeHistoricalVersions',
  'active',
  'sideQuery',
]);
const ACTIVE_KEYS = new Set(['maxFilesPerCall']);
const SIDE_QUERY_KEYS = new Set([
  'model',
  'timeoutMs',
  'maxCandidateEntries',
  'maxSelectedEntries',
  'maxAttempts',
]);

function fail(message: string): never {
  throw new OmniMemoryConfigError(message);
}

function requireRecord(
  value: unknown,
  where: string,
  allowedKeys: Set<string>,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(`${where}: must be an object (got ${JSON.stringify(value)})`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(
        `${where}: unknown key "${key}" (allowed: ${[...allowedKeys].join(', ')})`,
      );
    }
  }
  return value;
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`${where}: must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    fail(`${where}: must be a boolean (got ${JSON.stringify(value)})`);
  }
  return value;
}

function normalizeKinds(value: unknown, where: string): OmniMemoryRecallKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where}: must be a non-empty array of entry kinds`);
  }
  const known = new Set<string>(OMNI_MEMORY_RECALL_KINDS);
  const seen = new Set<OmniMemoryRecallKind>();
  for (const kind of value) {
    if (typeof kind !== 'string' || !known.has(kind)) {
      fail(
        `${where}: unknown entry kind ${JSON.stringify(kind)} ` +
          `(allowed: ${OMNI_MEMORY_RECALL_KINDS.join(', ')})`,
      );
    }
    if (seen.has(kind as OmniMemoryRecallKind)) {
      fail(`${where}: duplicate entry kind "${kind}"`);
    }
    seen.add(kind as OmniMemoryRecallKind);
  }
  return [...seen];
}

/**
 * Normalize `omni.memory`. Scalars default per-key; the `kinds` array
 * replaces wholesale when present (never element-merged — M §9). Invalid
 * configuration is startup-fatal.
 */
export function normalizeOmniMemoryConfig(
  raw: RawOmniMemorySettings | undefined,
): NormalizedOmniMemoryConfig {
  const defaults = DEFAULT_OMNI_MEMORY_CONFIG;

  let maxInlineTextBytes = defaults.collection.maxInlineTextBytes;
  if (raw?.collection !== undefined) {
    const collection = requireRecord(
      raw.collection,
      'omni.memory.collection',
      COLLECTION_KEYS,
    );
    if (collection['maxInlineTextBytes'] !== undefined) {
      maxInlineTextBytes = positiveInteger(
        collection['maxInlineTextBytes'],
        'omni.memory.collection.maxInlineTextBytes',
      );
    }
  }

  const recall = { ...defaults.recall };
  recall.kinds = [...defaults.recall.kinds];
  recall.active = { ...defaults.recall.active };
  recall.sideQuery = { ...defaults.recall.sideQuery };

  if (raw?.recall !== undefined) {
    const rawRecall = requireRecord(
      raw.recall,
      'omni.memory.recall',
      RECALL_KEYS,
    );

    if (rawRecall['mode'] !== undefined) {
      const mode = rawRecall['mode'];
      if (mode !== 'active' && mode !== 'sideQuery') {
        fail(
          `omni.memory.recall.mode: must be "active" or "sideQuery" ` +
            `(got ${JSON.stringify(mode)})`,
        );
      }
      recall.mode = mode;
    }
    if (rawRecall['maxEntries'] !== undefined) {
      recall.maxEntries = positiveInteger(
        rawRecall['maxEntries'],
        'omni.memory.recall.maxEntries',
      );
    }
    if (rawRecall['maxTextChars'] !== undefined) {
      recall.maxTextChars = positiveInteger(
        rawRecall['maxTextChars'],
        'omni.memory.recall.maxTextChars',
      );
    }
    if (rawRecall['kinds'] !== undefined) {
      recall.kinds = normalizeKinds(
        rawRecall['kinds'],
        'omni.memory.recall.kinds',
      );
    }
    if (rawRecall['includeHistoricalVersions'] !== undefined) {
      recall.includeHistoricalVersions = requireBoolean(
        rawRecall['includeHistoricalVersions'],
        'omni.memory.recall.includeHistoricalVersions',
      );
    }

    if (rawRecall['active'] !== undefined) {
      const active = requireRecord(
        rawRecall['active'],
        'omni.memory.recall.active',
        ACTIVE_KEYS,
      );
      if (active['maxFilesPerCall'] !== undefined) {
        recall.active.maxFilesPerCall = positiveInteger(
          active['maxFilesPerCall'],
          'omni.memory.recall.active.maxFilesPerCall',
        );
      }
    }

    if (rawRecall['sideQuery'] !== undefined) {
      const sq = requireRecord(
        rawRecall['sideQuery'],
        'omni.memory.recall.sideQuery',
        SIDE_QUERY_KEYS,
      );
      if (sq['model'] !== undefined) {
        const model = sq['model'];
        if (model !== null && (typeof model !== 'string' || model === '')) {
          fail(
            `omni.memory.recall.sideQuery.model: must be null or a ` +
              `non-empty string (got ${JSON.stringify(model)})`,
          );
        }
        recall.sideQuery.model = model;
      }
      for (const key of [
        'timeoutMs',
        'maxCandidateEntries',
        'maxSelectedEntries',
        'maxAttempts',
      ] as const) {
        if (sq[key] !== undefined) {
          recall.sideQuery[key] = positiveInteger(
            sq[key],
            `omni.memory.recall.sideQuery.${key}`,
          );
        }
      }
    }
  }

  // Cross-field budget ordering (M §9): a selector may never pick more
  // than recall returns, and recall may never return more than the
  // selector was shown.
  if (recall.sideQuery.maxSelectedEntries > recall.maxEntries) {
    fail(
      `omni.memory.recall.sideQuery.maxSelectedEntries ` +
        `(${recall.sideQuery.maxSelectedEntries}) must not exceed ` +
        `omni.memory.recall.maxEntries (${recall.maxEntries})`,
    );
  }
  if (recall.maxEntries > recall.sideQuery.maxCandidateEntries) {
    fail(
      `omni.memory.recall.maxEntries (${recall.maxEntries}) must not ` +
        `exceed omni.memory.recall.sideQuery.maxCandidateEntries ` +
        `(${recall.sideQuery.maxCandidateEntries})`,
    );
  }

  return { collection: { maxInlineTextBytes }, recall };
}
