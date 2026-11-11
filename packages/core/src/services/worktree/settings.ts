/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import type { WorktreeCreationSettings } from './contracts.js';

function asStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    runLogger.warn(
      `Ignoring worktree.${key}: expected an array of strings, got ${typeof value}.`,
    );
    return undefined;
  }
  const entries = value.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  if (entries.length !== value.length) {
    runLogger.warn(
      `Ignoring ${value.length - entries.length} non-string entr${
        value.length - entries.length === 1 ? 'y' : 'ies'
      } in worktree.${key}.`,
    );
  }
  return entries.length > 0 ? entries : undefined;
}

/**
 * Convert loosely typed settings into `WorktreeCreationSettings`.
 *
 * Settings arrive from user-authored JSON, so `baseRef` can hold any string. An
 * unrecognized value falls back to the default instead of reaching Git, where
 * it would surface as a confusing revision-parsing failure.
 */
export function normalizeWorktreeCreationSettings(
  raw: unknown,
): WorktreeCreationSettings {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;

  const normalized: WorktreeCreationSettings = {};

  const baseRef = source['baseRef'];
  if (baseRef === 'fresh' || baseRef === 'head') {
    normalized.baseRef = baseRef;
  } else if (typeof baseRef === 'string' && baseRef.trim() !== '') {
    runLogger.warn(
      `Ignoring unsupported worktree.baseRef ${JSON.stringify(baseRef)}; expected "fresh" or "head".`,
    );
  }

  const sparsePaths = asStringArray(source['sparsePaths'], 'sparsePaths');
  if (sparsePaths) normalized.sparsePaths = sparsePaths;

  const symlinkDirectories = asStringArray(
    source['symlinkDirectories'],
    'symlinkDirectories',
  );
  if (symlinkDirectories) normalized.symlinkDirectories = symlinkDirectories;

  return normalized;
}
