/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isNodeError } from '../utils/errors.js';
import { getSessionStatePath } from './session-state-paths.js';
import {
  FixedSessionStateKeyProvider,
  SessionStateCrypto,
  SessionStateCryptoError,
  SessionStateDecryptionError,
  type SessionStateKeyProvider,
  type SessionStateSealedRecord,
} from './session-state-crypto.js';
import { ENV_SESSION_STATE_PLAINTEXT } from '../config/brand.js';
import { runLogger } from '../utils/runLogger.js';

export type SessionStateSegments = Record<string, unknown>;

export interface SessionStatePayload {
  sessionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workspaceDirectories?: string[];
  segments: SessionStateSegments;
  encryptedSegmentKeys: string[];
}

export interface SessionStateFile {
  sessionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workspaceDirectories?: string[];
  data: SessionStateSegments;
  items: Record<string, SessionStateSealedRecord>;
}

export interface SessionStateStoreOptions {
  projectRoot: string;
  sessionId: string;
  configHomeDir?: string;
  keyProvider?: SessionStateKeyProvider;
  now?: () => Date;
  encryptPrivateSegments?: boolean;
  /**
   * Whether state changes are written to disk.
   *
   * When disabled, an existing state file is loaded once so a resumed session
   * can restore its runtime state, then all changes remain in memory.
   */
  persist?: boolean;
}

const operationChainsByFilePath = new Map<string, Promise<void>>();

export class SessionStateStore {
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly filePath: string;
  private readonly crypto: SessionStateCrypto;
  private readonly now: () => Date;
  private readonly encryptPrivateSegments: boolean;
  private readonly persist: boolean;
  private inMemoryPayload: SessionStatePayload | null | undefined;
  private readonly recoveredStateBackups = new Set<string>();

  constructor(options: SessionStateStoreOptions) {
    this.projectRoot = options.projectRoot;
    this.sessionId = options.sessionId;
    this.filePath = getSessionStatePath(
      options.projectRoot,
      options.sessionId,
      options.configHomeDir,
    );
    this.crypto = new SessionStateCrypto(
      options.keyProvider ?? new FixedSessionStateKeyProvider(),
    );
    this.now = options.now ?? (() => new Date());
    this.encryptPrivateSegments =
      options.encryptPrivateSegments ?? shouldEncryptPrivateSegments();
    this.persist = options.persist ?? true;
  }

  getSessionStatePath(): string {
    return this.filePath;
  }

  async load(): Promise<SessionStatePayload | null> {
    if (!this.persist && this.inMemoryPayload !== undefined) {
      return cloneSessionStatePayload(this.inMemoryPayload);
    }

    const stateFile = await this.readStateFile();
    if (!stateFile) {
      if (!this.persist) {
        this.inMemoryPayload = null;
      }
      return null;
    }

    const payload = await parseSessionStateFile(
      stateFile,
      this.sessionId,
      (segmentKey, envelope) =>
        this.decryptSegment(stateFile, segmentKey, envelope),
    );
    if (!this.persist) {
      this.inMemoryPayload = cloneSessionStatePayload(payload);
    }
    return payload;
  }

  async loadOrCreate(): Promise<SessionStatePayload> {
    return (await this.load()) ?? this.createEmptyPayload();
  }

  async save(payload: SessionStatePayload): Promise<void> {
    await this.enqueueOperation(async () => {
      await this.writePayload(payload);
    });
  }

  async update(
    updater: (payload: SessionStatePayload) => void | Promise<void>,
  ): Promise<SessionStatePayload> {
    let updatedPayload: SessionStatePayload | undefined;

    await this.enqueueOperation(async () => {
      const payload = (await this.load()) ?? this.createEmptyPayload();
      await updater(payload);
      updatedPayload = {
        ...payload,
        revision: payload.revision + 1,
        updatedAt: this.now().toISOString(),
        ...(payload.workspaceDirectories
          ? { workspaceDirectories: [...payload.workspaceDirectories] }
          : {}),
        segments: { ...payload.segments },
        encryptedSegmentKeys: [...payload.encryptedSegmentKeys],
      };
      await this.writePayload(updatedPayload);
    });

    if (!updatedPayload) {
      throw new Error('Session state update did not produce a payload.');
    }
    return updatedPayload;
  }

  async getSegment<T = unknown>(segmentKey: string): Promise<T | undefined> {
    if (!this.persist) {
      const payload = await this.load();
      return payload?.segments[segmentKey] as T | undefined;
    }

    const stateFile = await this.readStateFile();
    if (!stateFile) {
      return undefined;
    }
    validateSessionStateFile(stateFile, this.sessionId);

    const encryptedRecord = stateFile.items[segmentKey];
    if (encryptedRecord) {
      return (await this.decryptSegment(
        stateFile,
        segmentKey,
        encryptedRecord,
      )) as T;
    }
    return stateFile.data[segmentKey] as T | undefined;
  }

  private async decryptSegment(
    stateFile: SessionStateFile,
    segmentKey: string,
    envelope: SessionStateSealedRecord,
  ): Promise<unknown> {
    try {
      const decrypted = await this.crypto.decrypt(envelope, {
        sessionId: this.sessionId,
        projectRoot: this.projectRoot,
        segmentKey,
      });
      return JSON.parse(decrypted) as unknown;
    } catch (error) {
      // Only the disposable usage cache may recover. Format/JSON errors and
      // other private segments remain strict failures.
      if (
        segmentKey !== 's0' ||
        !(error instanceof SessionStateDecryptionError)
      ) {
        throw error;
      }
      const contents = JSON.stringify(stateFile, null, 2) + '\n';
      const digest = createHash('sha256').update(contents).digest('hex');
      const backupPath = `${this.filePath}.s0-${digest}.bak`;
      if (!this.recoveredStateBackups.has(digest)) {
        // Do not change state if preserving the evidence fails. Ephemeral
        // sessions keep the original file untouched and must not write backups.
        if (this.persist) await atomicWriteFile(backupPath, contents);
        this.recoveredStateBackups.add(digest);
        runLogger.warn(
          '[session-state] usage authentication failed; estimating context; historical totals unavailable',
          {
            sessionId: this.sessionId,
            segmentKey,
            ...(this.persist ? { backupPath } : {}),
          },
        );
      }
      // Keep a marker rather than zero usage: credits-only flushes must not
      // manufacture a token anchor, and new charges cannot restore old totals.
      return {
        updatedAt: stateFile.updatedAt,
        historyIncomplete: true,
      };
    }
  }

  async getWorkspaceDirectories(): Promise<string[] | undefined> {
    if (!this.persist) {
      const payload = await this.load();
      return payload?.workspaceDirectories
        ? [...payload.workspaceDirectories]
        : undefined;
    }

    const stateFile = await this.readStateFile();
    if (!stateFile) {
      return undefined;
    }
    validateSessionStateFile(stateFile, this.sessionId);
    return parseStringArray(stateFile.workspaceDirectories);
  }

  async setWorkspaceDirectories(directories: readonly string[]): Promise<void> {
    if (!this.persist) {
      await this.update((payload) => {
        payload.workspaceDirectories = [...directories];
      });
      return;
    }

    await this.enqueueOperation(async () => {
      const now = this.now().toISOString();
      const existingStateFile = await this.readStateFile();
      const stateFile: SessionStateFile = existingStateFile ?? {
        sessionId: this.sessionId,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        data: {},
        items: {},
      };
      validateSessionStateFile(stateFile, this.sessionId);

      await atomicWriteStateFile(this.filePath, {
        ...stateFile,
        revision: stateFile.revision + 1,
        updatedAt: now,
        workspaceDirectories: [...directories],
      });
    });
  }

  /** Creates and owns a new state file without replacing existing session state. */
  async createExclusive(
    workspaceDirectories?: readonly string[],
  ): Promise<void> {
    await this.enqueueOperation(async () => {
      if (!this.persist) {
        if (this.inMemoryPayload !== undefined && this.inMemoryPayload !== null) {
          throw Object.assign(new Error('Session state already exists.'), {
            code: 'EEXIST',
          });
        }
        const payload = this.createEmptyPayload();
        if (workspaceDirectories) {
          payload.workspaceDirectories = [...workspaceDirectories];
        }
        this.inMemoryPayload = payload;
        return;
      }

      const now = this.now().toISOString();
      const stateFile: SessionStateFile = {
        sessionId: this.sessionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...(workspaceDirectories
          ? { workspaceDirectories: [...workspaceDirectories] }
          : {}),
        data: {},
        items: {},
      };
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await chmodIfSupported(directory, 0o700);

      let created = false;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(this.filePath, 'wx', 0o600);
        created = true;
        await handle.writeFile(`${JSON.stringify(stateFile, null, 2)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await chmodIfSupported(this.filePath, 0o600);
        await fsyncDirectoryIfSupported(directory);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (created) {
          await fs.rm(this.filePath, { force: true });
        }
        throw error;
      }
    });
  }

  async setSegment(
    segmentKey: string,
    value: unknown,
    options: { encrypted?: boolean } = {},
  ): Promise<SessionStatePayload> {
    return this.update((payload) => {
      const hadSegment = Object.prototype.hasOwnProperty.call(
        payload.segments,
        segmentKey,
      );
      payload.segments[segmentKey] = value;
      const encryptedKeys = new Set(payload.encryptedSegmentKeys);
      const shouldEncrypt =
        options.encrypted ??
        (hadSegment ? encryptedKeys.has(segmentKey) : true);
      if (shouldEncrypt) {
        encryptedKeys.add(segmentKey);
      } else {
        encryptedKeys.delete(segmentKey);
      }
      payload.encryptedSegmentKeys = [...encryptedKeys].sort();
    });
  }

  async deleteSegment(segmentKey: string): Promise<SessionStatePayload> {
    return this.update((payload) => {
      delete payload.segments[segmentKey];
      payload.encryptedSegmentKeys = payload.encryptedSegmentKeys.filter(
        (key) => key !== segmentKey,
      );
    });
  }

  async delete(): Promise<void> {
    await this.enqueueOperation(async () => {
      if (!this.persist) {
        this.inMemoryPayload = null;
        return;
      }
      await fs.rm(this.filePath, { force: true });
    });
  }

  private createEmptyPayload(): SessionStatePayload {
    const now = this.now().toISOString();
    return {
      sessionId: this.sessionId,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      segments: {},
      encryptedSegmentKeys: [],
    };
  }

  private async readStateFile(): Promise<SessionStateFile | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as SessionStateFile;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new SessionStateCryptoError(
          `Session state file contains invalid JSON: ${this.filePath}`,
        );
      }
      throw error;
    }
  }

  private async writePayload(payload: SessionStatePayload): Promise<void> {
    if (payload.sessionId !== this.sessionId) {
      throw new Error('Session state payload sessionId does not match store.');
    }

    if (!this.persist) {
      this.inMemoryPayload = cloneSessionStatePayload(payload);
      return;
    }

    const existingStateFile = await this.readStateFile();
    const encryptedSegmentKeys = new Set(payload.encryptedSegmentKeys);
    const data: SessionStateSegments = {};
    const items: Record<string, SessionStateSealedRecord> = {};

    for (const [segmentKey, segmentValue] of Object.entries(payload.segments)) {
      if (encryptedSegmentKeys.has(segmentKey) && this.encryptPrivateSegments) {
        items[segmentKey] = await this.crypto.encrypt(
          JSON.stringify(segmentValue),
          {
            sessionId: this.sessionId,
            projectRoot: this.projectRoot,
            segmentKey,
          },
          {
            createdAt:
              existingStateFile?.items[segmentKey]?.c ?? payload.createdAt,
            updatedAt: payload.updatedAt,
          },
        );
      } else {
        data[segmentKey] = segmentValue;
      }
    }

    const stateFile: SessionStateFile = {
      sessionId: payload.sessionId,
      revision: payload.revision,
      createdAt: existingStateFile?.createdAt ?? payload.createdAt,
      updatedAt: payload.updatedAt,
      ...(payload.workspaceDirectories
        ? { workspaceDirectories: [...payload.workspaceDirectories] }
        : existingStateFile?.workspaceDirectories
          ? {
              workspaceDirectories: [...existingStateFile.workspaceDirectories],
            }
          : {}),
      data,
      items,
    };

    await atomicWriteStateFile(this.filePath, stateFile);
  }

  private async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueStateFileOperation(this.filePath, operation);
  }
}

function cloneSessionStatePayload(
  payload: SessionStatePayload | null,
): SessionStatePayload | null {
  return payload === null ? null : structuredClone(payload);
}

function enqueueStateFileOperation<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = operationChainsByFilePath.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => operation());
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  operationChainsByFilePath.set(filePath, next);
  void next.finally(() => {
    if (operationChainsByFilePath.get(filePath) === next) {
      operationChainsByFilePath.delete(filePath);
    }
  });
  return run;
}

function shouldEncryptPrivateSegments(): boolean {
  return !isTruthyEnv(process.env[ENV_SESSION_STATE_PLAINTEXT]);
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

async function parseSessionStateFile(
  stateFile: SessionStateFile,
  expectedSessionId: string,
  decryptSegment: (
    segmentKey: string,
    record: SessionStateSealedRecord,
  ) => Promise<unknown>,
): Promise<SessionStatePayload> {
  validateSessionStateFile(stateFile, expectedSessionId);

  const segments: SessionStateSegments = { ...stateFile.data };
  const encryptedSegmentKeys = Object.keys(stateFile.items).sort();
  for (const segmentKey of encryptedSegmentKeys) {
    const record = stateFile.items[segmentKey];
    if (!record) {
      continue;
    }
    segments[segmentKey] = await decryptSegment(segmentKey, record);
  }

  const workspaceDirectories = parseStringArray(stateFile.workspaceDirectories);

  return {
    sessionId: stateFile.sessionId,
    revision: stateFile.revision,
    createdAt: stateFile.createdAt,
    updatedAt: stateFile.updatedAt,
    ...(workspaceDirectories ? { workspaceDirectories } : {}),
    segments,
    encryptedSegmentKeys,
  };
}

function validateSessionStateFile(
  stateFile: SessionStateFile,
  expectedSessionId: string,
): void {
  if (stateFile.sessionId !== expectedSessionId) {
    throw new Error('Session state file sessionId does not match store.');
  }
  if (
    typeof stateFile.revision !== 'number' ||
    typeof stateFile.createdAt !== 'string' ||
    typeof stateFile.updatedAt !== 'string' ||
    !stateFile.data ||
    typeof stateFile.data !== 'object' ||
    !stateFile.items ||
    typeof stateFile.items !== 'object'
  ) {
    throw new Error('Session state file has an invalid shape.');
  }
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (item): item is string => typeof item === 'string',
  );
  return strings.length === value.length ? strings : undefined;
}

async function atomicWriteStateFile(
  filePath: string,
  stateFile: SessionStateFile,
): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(stateFile, null, 2)}\n`);
}

async function atomicWriteFile(
  filePath: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await chmodIfSupported(directory, 0o700);

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(temporaryPath, filePath);
    renamed = true;
    await chmodIfSupported(filePath, 0o600);
    await fsyncDirectoryIfSupported(directory);
  } finally {
    if (!renamed) {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}

async function chmodIfSupported(
  targetPath: string,
  mode: number,
): Promise<void> {
  try {
    await fs.chmod(targetPath, mode);
  } catch (error) {
    if (
      !isNodeError(error) ||
      (error.code !== 'ENOSYS' &&
        !(process.platform === 'win32' && error.code === 'EPERM'))
    ) {
      throw error;
    }
  }
}

async function fsyncDirectoryIfSupported(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (
      !isNodeError(error) ||
      (error.code !== 'EINVAL' &&
        error.code !== 'EISDIR' &&
        error.code !== 'ENOSYS' &&
        error.code !== 'ENOTSUP' &&
        error.code !== 'EPERM')
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
