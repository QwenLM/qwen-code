/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

/**
 * Converts the SDK callback's public camelCase shape into the Worker/RM wire
 * Artifact shape. Filesystem/root validation is performed by
 * SessionArtifactRuntime before the snapshot becomes authoritative.
 */

import * as path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Artifact field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError(`Artifact field "${key}" must be a string`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Artifact field "${key}" must be a non-negative finite number`,
    );
  }
  return value;
}

function changedCount(
  record: Record<string, unknown>,
  key: 'additions' | 'deletions',
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(
      `Artifact field "${key}" must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`Artifact field "${key}" must be a boolean`);
  }
  return value;
}

function parseArtifact(value: unknown): SDKArtifactInfo {
  if (!isRecord(value)) {
    throw new TypeError('artifacts must contain objects');
  }
  const artifactPath = requiredString(value, 'path');
  if (!path.isAbsolute(artifactPath)) {
    throw new TypeError('Artifact field "path" must be absolute');
  }

  let group: SDKArtifactInfo['group'];
  if (value['group'] !== undefined) {
    if (!isRecord(value['group'])) {
      throw new TypeError('Artifact field "group" must be an object');
    }
    group = {
      key: requiredString(value['group'], 'key'),
      name: requiredString(value['group'], 'name'),
    };
  }

  const relativePath = optionalString(value, 'relativePath');
  const size = optionalNumber(value, 'size');
  const mime = optionalString(value, 'mime');
  const mtime = optionalNumber(value, 'mtime');
  const base = {
    path: artifactPath,
    display_path: requiredString(value, 'displayPath'),
    name: requiredString(value, 'name'),
    ...(group ? { group } : {}),
    ...(relativePath !== undefined ? { relative_path: relativePath } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(mtime !== undefined ? { mtime } : {}),
  };

  if (value['kind'] === 'presented') {
    return { ...base, kind: 'presented' };
  }
  if (value['kind'] !== 'changed') {
    throw new TypeError(
      'Artifact field "kind" must be "presented" or "changed"',
    );
  }
  return {
    ...base,
    kind: 'changed',
    additions: changedCount(value, 'additions'),
    deletions: changedCount(value, 'deletions'),
    is_new: requiredBoolean(value, 'isNew'),
  };
}

export function parseResolveSessionArtifactsResponse(
  value: unknown,
): SDKArtifactInfo[] {
  if (!isRecord(value) || !Array.isArray(value['artifacts'])) {
    throw new TypeError(
      'resolve_session_artifacts response must contain an artifacts array',
    );
  }
  return value['artifacts'].map(parseArtifact);
}
