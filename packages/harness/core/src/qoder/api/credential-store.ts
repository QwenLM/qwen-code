/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Storage } from '../../config/storage.js';
import { isNodeError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  QODER_CREDENTIAL_VERSION,
  toQoderAccountSummary,
  type QoderAccountInput,
  type QoderAccountRecord,
  type QoderAccountSummary,
  type QoderCredentialsSnapshot,
} from './account.js';
import { QODER_ACCOUNT_REGIONS, isQoderAccountRegion } from './regions.js';

const CREDENTIAL_FILENAME = 'qoder_oauth_creds.json';
const CREDENTIAL_FILE_MODE = 0o600;
const CREDENTIAL_DIR_MODE = 0o700;

export class QoderCredentialError extends Error {
  readonly code: 'unsupported_version';

  constructor(message: string, code: 'unsupported_version') {
    super(message);
    this.name = 'QoderCredentialError';
    this.code = code;
  }
}

export interface QoderCredentialStoreOptions {
  readonly filePath?: string;
  readonly now?: () => number;
}

export function getQoderCredentialsPath(): string {
  return path.join(Storage.getGlobalConfigDir(), CREDENTIAL_FILENAME);
}

/**
 * File-backed repository for Qoder accounts. One record per region; the file
 * is private to the OS user and written atomically.
 */
export class QoderCredentialStore {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(options: QoderCredentialStoreOptions = {}) {
    this.filePath = options.filePath ?? getQoderCredentialsPath();
    this.now = options.now ?? Date.now;
  }

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<QoderCredentialsSnapshot> {
    return readQoderCredentials(this.filePath);
  }

  async getAccount(
    region: QoderAccountRecord['region'],
  ): Promise<QoderAccountRecord | undefined> {
    const snapshot = await this.read();
    return snapshot.accounts[region];
  }

  async upsert(input: QoderAccountInput): Promise<QoderAccountRecord> {
    const snapshot = await this.read();
    const existing = snapshot.accounts[input.region];
    const now = this.now();
    const record: QoderAccountRecord = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    snapshot.accounts[input.region] = record;
    await writeQoderCredentials(this.filePath, snapshot);
    return record;
  }

  /** Remove one region's account; returns whether an account existed. */
  async clear(region: QoderAccountRecord['region']): Promise<boolean> {
    const snapshot = await this.read();
    if (!snapshot.accounts[region]) {
      return false;
    }
    delete snapshot.accounts[region];
    await writeQoderCredentials(this.filePath, snapshot);
    return true;
  }

  async listSummaries(): Promise<
    Partial<Record<QoderAccountRecord['region'], QoderAccountSummary>>
  > {
    const snapshot = await this.read();
    const summaries: Partial<
      Record<QoderAccountRecord['region'], QoderAccountSummary>
    > = {};
    for (const region of QODER_ACCOUNT_REGIONS) {
      const account = snapshot.accounts[region];
      if (account) {
        summaries[region] = toQoderAccountSummary(account);
      }
    }
    return summaries;
  }
}

export async function readQoderCredentials(
  filePath: string = getQoderCredentialsPath(),
): Promise<QoderCredentialsSnapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return emptySnapshot();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    runLogger.warn(
      `[qoder-credentials] ignoring unreadable credential file at ${filePath}`,
    );
    return emptySnapshot();
  }

  return normalizeSnapshot(parsed, filePath);
}

/**
 * Synchronous presence check for provider composition: reports whether an
 * account is stored for the region without validating or refreshing it.
 */
export function hasQoderStoredAccount(
  region: QoderAccountRecord['region'],
  filePath: string = getQoderCredentialsPath(),
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    return normalizeSnapshot(parsed, filePath).accounts[region] !== undefined;
  } catch {
    return false;
  }
}

export async function writeQoderCredentials(
  filePath: string,
  snapshot: QoderCredentialsSnapshot,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: CREDENTIAL_DIR_MODE,
  });
  await atomicWriteFile(
    filePath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
}

function emptySnapshot(): QoderCredentialsSnapshot {
  return { version: QODER_CREDENTIAL_VERSION, accounts: {} };
}

function normalizeSnapshot(
  value: unknown,
  filePath: string,
): QoderCredentialsSnapshot {
  if (!isRecord(value)) {
    runLogger.warn(
      `[qoder-credentials] ignoring malformed credential file at ${filePath}`,
    );
    return emptySnapshot();
  }

  if (value['version'] !== QODER_CREDENTIAL_VERSION) {
    throw new QoderCredentialError(
      `Unsupported Qoder credential version at ${filePath}: ${String(value['version'])}`,
      'unsupported_version',
    );
  }

  const rawAccounts = isRecord(value['accounts']) ? value['accounts'] : {};
  const accounts: Partial<Record<string, QoderAccountRecord>> = {};
  for (const region of QODER_ACCOUNT_REGIONS) {
    const account = rawAccounts[region];
    if (isQoderAccountRecord(account)) {
      accounts[region] = account;
    } else if (account !== undefined) {
      runLogger.warn(
        `[qoder-credentials] ignoring malformed account for region '${region}' at ${filePath}`,
      );
    }
  }

  return {
    version: QODER_CREDENTIAL_VERSION,
    accounts: accounts as QoderCredentialsSnapshot['accounts'],
  };
}

function isQoderAccountRecord(value: unknown): value is QoderAccountRecord {
  if (!isRecord(value)) return false;
  return (
    isQoderAccountRegion(value['region']) &&
    isNonEmptyString(value['userId']) &&
    isNonEmptyString(value['userName']) &&
    isNonEmptyString(value['accessToken']) &&
    isNonEmptyString(value['refreshToken']) &&
    isFiniteNumber(value['expiresAt']) &&
    isFiniteNumber(value['createdAt']) &&
    isFiniteNumber(value['updatedAt'])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

async function atomicWriteFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await fs.open(temporaryPath, 'wx', CREDENTIAL_FILE_MODE);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}
