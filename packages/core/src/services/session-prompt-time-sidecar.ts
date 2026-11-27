/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';

const isoTimestampSchema = z.string().datetime({ offset: true });
const tailHexSchema = /^[0-9a-f]{2,128}$/;

export interface SessionPromptTimeSidecar {
  version: 1;
  fileIdentity: { dev: number; ino: number };
  snapshotSize: number;
  lastUpdated: string;
  lastUserPromptAt: string | null;
  leafUuid: string;
  firstRecordOwner: { sessionId: string; cwd: string };
  tailHex?: string;
  managed?: boolean;
}

export const SESSION_PROMPT_TIME_SIDECAR_SUFFIX = '.prompt-time.json';

export function sessionPromptTimeSidecarPath(
  chatsDir: string,
  sessionId: string,
): string {
  return path.join(
    chatsDir,
    `${sessionId}${SESSION_PROMPT_TIME_SIDECAR_SUFFIX}`,
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Windows Stats.ino can exceed Number.MAX_SAFE_INTEGER; match the reader's
// file-identity check rather than rejecting valid Windows inodes.
function isNonNegativeFileId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseSessionPromptTimeSidecar(
  raw: string,
): SessionPromptTimeSidecar | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1) return undefined;

  const rawIdentity = record['fileIdentity'];
  if (
    typeof rawIdentity !== 'object' ||
    rawIdentity === null ||
    Array.isArray(rawIdentity)
  ) {
    return undefined;
  }
  const identity = rawIdentity as Record<string, unknown>;
  if (
    !isNonNegativeFileId(identity['dev']) ||
    !isNonNegativeFileId(identity['ino'])
  ) {
    return undefined;
  }

  const snapshotSize = record['snapshotSize'];
  if (!isNonNegativeSafeInteger(snapshotSize) || snapshotSize === 0) {
    return undefined;
  }

  const lastUpdated = record['lastUpdated'];
  if (
    !isNonEmptyString(lastUpdated) ||
    !isoTimestampSchema.safeParse(lastUpdated).success
  ) {
    return undefined;
  }

  const lastUserPromptAt = record['lastUserPromptAt'];
  if (
    lastUserPromptAt !== null &&
    (!isNonEmptyString(lastUserPromptAt) ||
      !isoTimestampSchema.safeParse(lastUserPromptAt).success)
  ) {
    return undefined;
  }

  const leafUuid = record['leafUuid'];
  if (!isNonEmptyString(leafUuid)) return undefined;

  const rawOwner = record['firstRecordOwner'];
  if (
    typeof rawOwner !== 'object' ||
    rawOwner === null ||
    Array.isArray(rawOwner)
  ) {
    return undefined;
  }
  const owner = rawOwner as Record<string, unknown>;
  if (
    !isNonEmptyString(owner['sessionId']) ||
    !isNonEmptyString(owner['cwd'])
  ) {
    return undefined;
  }

  const tailHex = record['tailHex'];
  if (
    tailHex !== undefined &&
    (typeof tailHex !== 'string' ||
      tailHex.length % 2 !== 0 ||
      !tailHexSchema.test(tailHex))
  ) {
    return undefined;
  }

  const managed = record['managed'];
  if (managed !== undefined && typeof managed !== 'boolean') {
    return undefined;
  }

  return {
    version: 1,
    fileIdentity: { dev: identity['dev'], ino: identity['ino'] },
    snapshotSize,
    lastUpdated,
    lastUserPromptAt,
    leafUuid,
    firstRecordOwner: {
      sessionId: owner['sessionId'],
      cwd: owner['cwd'],
    },
    ...(tailHex !== undefined ? { tailHex } : {}),
    ...(managed !== undefined ? { managed } : {}),
  };
}

export async function readSessionPromptTimeSidecarAsync(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionPromptTimeSidecar | undefined> {
  options.signal?.throwIfAborted();
  let raw: string;
  try {
    raw = options.signal
      ? await fsPromises.readFile(filePath, {
          encoding: 'utf8',
          signal: options.signal,
        })
      : await fsPromises.readFile(filePath, 'utf8');
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
  return parseSessionPromptTimeSidecar(raw);
}

export function writeSessionPromptTimeSidecar(
  filePath: string,
  data: Omit<SessionPromptTimeSidecar, 'version'>,
): boolean {
  if (
    !isNonNegativeFileId(data.fileIdentity.dev) ||
    !isNonNegativeFileId(data.fileIdentity.ino) ||
    !isNonNegativeSafeInteger(data.snapshotSize) ||
    data.snapshotSize === 0 ||
    !isNonEmptyString(data.lastUpdated) ||
    !isoTimestampSchema.safeParse(data.lastUpdated).success ||
    (data.lastUserPromptAt !== null &&
      (!isNonEmptyString(data.lastUserPromptAt) ||
        !isoTimestampSchema.safeParse(data.lastUserPromptAt).success)) ||
    !isNonEmptyString(data.leafUuid) ||
    !isNonEmptyString(data.firstRecordOwner.sessionId) ||
    !isNonEmptyString(data.firstRecordOwner.cwd) ||
    (data.tailHex !== undefined &&
      (data.tailHex.length % 2 !== 0 || !tailHexSchema.test(data.tailHex)))
  ) {
    return false;
  }
  const payload: SessionPromptTimeSidecar = {
    version: 1,
    fileIdentity: {
      dev: data.fileIdentity.dev,
      ino: data.fileIdentity.ino,
    },
    snapshotSize: data.snapshotSize,
    lastUpdated: data.lastUpdated,
    lastUserPromptAt: data.lastUserPromptAt,
    leafUuid: data.leafUuid,
    firstRecordOwner: {
      sessionId: data.firstRecordOwner.sessionId,
      cwd: data.firstRecordOwner.cwd,
    },
    ...(data.tailHex !== undefined ? { tailHex: data.tailHex } : {}),
    ...(data.managed !== undefined ? { managed: data.managed } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function removeSessionPromptTimeSidecar(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; the transcript is authoritative.
  }
}

export function moveSessionPromptTimeSidecar(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
