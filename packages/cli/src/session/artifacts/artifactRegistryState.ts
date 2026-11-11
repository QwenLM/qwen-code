/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

import * as path from 'node:path';

const PERSISTENCE_VERSION = 1;

export type ArtifactClassification =
  | {
      kind: 'changed';
      additions: number;
      deletions: number;
      is_new: boolean;
    }
  | { kind: 'presented' };

export interface PersistedArtifactRegistryState {
  version: 1;
  records: PersistedArtifactRegistryRecord[];
  /** Tool-result messages already included in an authoritative recovery snapshot.
   * Absent on ordinary TUI/SDK state; live observations are never suppressed.
   */
  coveredToolResultUuids?: string[];
}

interface PersistedArtifactRegistryRecord {
  path: string;
  kind?: 'changed';
  additions?: number;
  deletions?: number;
  is_new?: boolean;
}

export interface ArtifactRegistryPersistence {
  load(): Promise<unknown>;
  save(state: PersistedArtifactRegistryState): Promise<void>;
}

export type ParsedArtifactRegistryState =
  | {
      state: 'known';
      records: Array<{
        path: string;
        classification: ArtifactClassification;
      }>;
      coveredToolResultUuids?: string[];
    }
  | { state: 'unknown' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function parseArtifactRegistryState(
  value: unknown,
): ParsedArtifactRegistryState {
  if (value === undefined) {
    return { state: 'known', records: [] };
  }
  if (
    !isRecord(value) ||
    value['version'] !== PERSISTENCE_VERSION ||
    !Array.isArray(value['records'])
  ) {
    return { state: 'unknown' };
  }

  const covered = value['coveredToolResultUuids'];
  if (
    covered !== undefined &&
    (!Array.isArray(covered) ||
      covered.some((uuid) => typeof uuid !== 'string' || uuid.length === 0) ||
      new Set(covered).size !== covered.length)
  )
    return { state: 'unknown' };

  const records: Array<{
    path: string;
    classification: ArtifactClassification;
  }> = [];
  for (const record of value['records']) {
    const persistedPath = isRecord(record)
      ? asString(record['path'])
      : undefined;
    if (
      persistedPath === undefined ||
      !path.isAbsolute(persistedPath) ||
      persistedPath.includes('\0')
    ) {
      return { state: 'unknown' };
    }
    const kind = record['kind'];
    if (kind === undefined) {
      if (
        record['additions'] !== undefined ||
        record['deletions'] !== undefined ||
        record['is_new'] !== undefined
      ) {
        return { state: 'unknown' };
      }
      records.push({
        path: persistedPath,
        classification: { kind: 'presented' },
      });
      continue;
    }
    const additions = asNonNegativeInteger(record['additions']);
    const deletions = asNonNegativeInteger(record['deletions']);
    const isNew = record['is_new'];
    if (
      kind !== 'changed' ||
      additions === undefined ||
      deletions === undefined ||
      typeof isNew !== 'boolean'
    ) {
      return { state: 'unknown' };
    }
    records.push({
      path: persistedPath,
      classification: {
        kind,
        additions,
        deletions,
        is_new: isNew,
      },
    });
  }
  return {
    state: 'known',
    records,
    ...(covered === undefined ? {} : { coveredToolResultUuids: [...covered] }),
  };
}

export function classificationFromArtifactEntry(
  entry: SDKArtifactInfo,
): ArtifactClassification {
  return entry.kind === 'changed'
    ? {
        kind: 'changed',
        additions: entry.additions,
        deletions: entry.deletions,
        is_new: entry.is_new,
      }
    : { kind: 'presented' };
}

export function serializeArtifactRegistryState(
  entries: readonly SDKArtifactInfo[],
  coveredToolResultUuids: readonly string[] = [],
): PersistedArtifactRegistryState {
  return {
    version: PERSISTENCE_VERSION,
    records: entries.map((entry) =>
      entry.kind === 'changed'
        ? {
            path: entry.path,
            kind: 'changed',
            additions: entry.additions,
            deletions: entry.deletions,
            is_new: entry.is_new,
          }
        : { path: entry.path },
    ),
    ...(coveredToolResultUuids.length === 0
      ? {}
      : { coveredToolResultUuids: [...coveredToolResultUuids] }),
  };
}
