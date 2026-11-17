/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';
import { MAX_PERSISTED_ARTIFACTS } from './session-artifact-persistence.js';

/**
 * Derived cache of the session's restorable artifact count, written next to
 * the transcript so the session list can surface it without reading the
 * journal. The journal is authoritative; a missing or stale sidecar only
 * costs the list a count, never correctness.
 */
export interface SessionArtifactSummarySidecar {
  version: 1;
  artifactCount: number;
  updatedAt: string;
}

export const SESSION_ARTIFACT_SUMMARY_SIDECAR_SUFFIX = '.artifacts.json';

export function sessionArtifactSummarySidecarPath(
  chatsDir: string,
  sessionId: string,
): string {
  return path.join(
    chatsDir,
    `${sessionId}${SESSION_ARTIFACT_SUMMARY_SIDECAR_SUFFIX}`,
  );
}

export function readSessionArtifactSummarySidecar(
  filePath: string,
): SessionArtifactSummarySidecar | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const artifactCount = record['artifactCount'];
  if (
    record['version'] !== 1 ||
    typeof artifactCount !== 'number' ||
    !Number.isSafeInteger(artifactCount) ||
    artifactCount < 0 ||
    artifactCount > MAX_PERSISTED_ARTIFACTS
  ) {
    return undefined;
  }
  const updatedAt =
    typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '';
  return {
    version: 1,
    artifactCount,
    updatedAt,
  };
}

/**
 * Persists the session's restorable artifact count next to the transcript.
 * Best-effort: a session must keep working when the sidecar cannot be
 * written, so callers get a boolean instead of an exception.
 */
export function writeSessionArtifactSummarySidecar(
  filePath: string,
  artifactCount: number,
): boolean {
  if (
    !Number.isSafeInteger(artifactCount) ||
    artifactCount < 0 ||
    artifactCount > MAX_PERSISTED_ARTIFACTS
  ) {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          artifactCount,
          updatedAt: new Date().toISOString(),
        } satisfies SessionArtifactSummarySidecar,
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

export function removeSessionArtifactSummarySidecar(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; the transcript is already gone.
  }
}

/**
 * Moves an artifact summary sidecar across archive states. A missing source
 * is a no-op because most sessions never get a sidecar.
 */
export function moveSessionArtifactSummarySidecar(
  from: string,
  to: string,
): void {
  if (!fs.existsSync(from)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
