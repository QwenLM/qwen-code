/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import { Storage } from '../config/storage.js';

const SCHEMA_VERSION = 1 as const;
const RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENV_HOST_ACTION_STORAGE_DIR = `${BRAND_FIXED_ENV_PREFIX}CLI_HOST_ACTION_STORAGE_DIR`;

export interface CompletedResultCorrelationRecord {
  schemaVersion: 1;
  resultUuid: string;
  sessionId: string;
  requestSetId: string;
  originClientType?: string;
  originProduct?: string;
  originCliVersion?: string;
  createdAt: string;
  expiresAt: string;
}

export interface StagedCompletedResultRecord {
  record: CompletedResultCorrelationRecord;
  stagedPath: string;
  committedPath: string;
}

function safeKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, 0o600);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export class HostActionStore {
  private readonly root: string;

  constructor(
    storageDir = process.env[ENV_HOST_ACTION_STORAGE_DIR] ??
      Storage.getGlobalConfigDir(),
  ) {
    this.root = path.join(storageDir, 'host-actions');
  }

  private resultPath(sessionId: string, resultUuid: string): string {
    return path.join(
      this.root,
      'result-index',
      `${safeKey(sessionId)}-${resultUuid}.json`,
    );
  }

  async stageCompletedResult(input: {
    resultUuid: string;
    sessionId: string;
    requestSetId: string;
    originClientType?: string;
    originProduct?: string;
    originCliVersion?: string;
  }): Promise<StagedCompletedResultRecord> {
    const now = new Date();
    const record: CompletedResultCorrelationRecord = {
      schemaVersion: SCHEMA_VERSION,
      ...input,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RESULT_TTL_MS).toISOString(),
    };
    const stagedPath = path.join(
      this.root,
      'result-index',
      '.staged',
      `${input.resultUuid}.${process.pid}.${Date.now()}.json`,
    );
    await writePrivateJson(stagedPath, record);
    return {
      record,
      stagedPath,
      committedPath: this.resultPath(input.sessionId, input.resultUuid),
    };
  }

  async commitCompletedResult(
    staged: StagedCompletedResultRecord,
  ): Promise<void> {
    try {
      await ensurePrivateDirectory(path.dirname(staged.committedPath));
      await fs.rename(staged.stagedPath, staged.committedPath);
      await fs.chmod(staged.committedPath, 0o600);
    } catch (error) {
      await fs.unlink(staged.stagedPath).catch(() => undefined);
      throw error;
    }
  }

  async getCompletedResult(
    sessionId: string,
    resultUuid: string,
  ): Promise<CompletedResultCorrelationRecord | undefined> {
    const record = await readJson<CompletedResultCorrelationRecord>(
      this.resultPath(sessionId, resultUuid),
    );
    if (!record || record.schemaVersion !== SCHEMA_VERSION) return undefined;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      await fs
        .unlink(this.resultPath(sessionId, resultUuid))
        .catch(() => undefined);
      return undefined;
    }
    return record;
  }
}
