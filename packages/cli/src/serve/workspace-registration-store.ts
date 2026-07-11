/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { MAX_WORKSPACE_PATH_LENGTH } from '@qwen-code/acp-bridge/workspacePaths';
import { getGlobalQwenDirLite } from '../config/storage-paths-lite.js';
import { MAX_REGISTERED_WORKSPACES } from './workspace-inputs.js';

const SCHEMA_VERSION = 1;
const MAX_SECONDARY_WORKSPACES = MAX_REGISTERED_WORKSPACES - 1;
const MAX_STORE_BYTES = 256 * 1024;
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  retries: {
    retries: 30,
    minTimeout: 10,
    maxTimeout: 100,
    factor: 1.2,
    randomize: true,
  },
};

export interface WorkspaceRegistrationSnapshot {
  schemaVersion: 1;
  primaryWorkspace: string;
  workspaces: string[];
}

export class WorkspaceRegistrationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRegistrationStoreError';
  }
}

function normalizedScopePath(primaryWorkspace: string): string {
  return os.platform() === 'win32'
    ? primaryWorkspace.toLowerCase()
    : primaryWorkspace;
}

export function workspaceRegistrationScopeHash(
  primaryWorkspace: string,
): string {
  return createHash('sha256')
    .update(normalizedScopePath(primaryWorkspace))
    .digest('hex');
}

export function workspaceRegistrationId(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 16);
}

export function getWorkspaceRegistrationStorePath(
  primaryWorkspace: string,
  qwenHome = getGlobalQwenDirLite(),
): string {
  return path.join(
    qwenHome,
    'daemon',
    'workspaces',
    `${workspaceRegistrationScopeHash(primaryWorkspace)}.json`,
  );
}

function emptySnapshot(
  primaryWorkspace: string,
): WorkspaceRegistrationSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    primaryWorkspace,
    workspaces: [],
  };
}

function validateWorkspacePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new WorkspaceRegistrationStoreError(
      `${label} must be an absolute path`,
    );
  }
  if (value.includes('\0') || value.length > MAX_WORKSPACE_PATH_LENGTH) {
    throw new WorkspaceRegistrationStoreError(`${label} is invalid`);
  }
  return value;
}

function parseSnapshot(
  raw: string,
  primaryWorkspace: string,
): WorkspaceRegistrationSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkspaceRegistrationStoreError(
      'Workspace registration store contains malformed JSON',
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceRegistrationStoreError(
      'Workspace registration store root must be an object',
    );
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== SCHEMA_VERSION) {
    throw new WorkspaceRegistrationStoreError(
      `Unsupported workspace registration schema ${String(record['schemaVersion'])}`,
    );
  }
  const storedPrimary = validateWorkspacePath(
    record['primaryWorkspace'],
    'primaryWorkspace',
  );
  if (
    normalizedScopePath(storedPrimary) !== normalizedScopePath(primaryWorkspace)
  ) {
    throw new WorkspaceRegistrationStoreError(
      'Workspace registration store primary does not match this daemon',
    );
  }
  if (!Array.isArray(record['workspaces'])) {
    throw new WorkspaceRegistrationStoreError(
      'Workspace registration store workspaces must be an array',
    );
  }
  if (record['workspaces'].length > MAX_SECONDARY_WORKSPACES) {
    throw new WorkspaceRegistrationStoreError(
      `Workspace registration store exceeds ${MAX_SECONDARY_WORKSPACES} entries`,
    );
  }
  const seen = new Set<string>();
  const workspaces = record['workspaces'].map((entry, index) => {
    const workspace = validateWorkspacePath(entry, `workspaces[${index}]`);
    const normalizedWorkspace = normalizedScopePath(workspace);
    if (normalizedWorkspace === normalizedScopePath(primaryWorkspace)) {
      throw new WorkspaceRegistrationStoreError(
        'Primary workspace cannot be stored as a secondary registration',
      );
    }
    if (seen.has(normalizedWorkspace)) {
      throw new WorkspaceRegistrationStoreError(
        'Workspace registration store contains duplicate paths',
      );
    }
    seen.add(normalizedWorkspace);
    return workspace;
  });
  return { schemaVersion: SCHEMA_VERSION, primaryWorkspace, workspaces };
}

const updateChains = new Map<string, Promise<unknown>>();

async function withInProcessLock<T>(
  filePath: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = updateChains.get(filePath) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next
    .catch(() => undefined)
    .finally(() => {
      if (updateChains.get(filePath) === settled) updateChains.delete(filePath);
    });
  updateChains.set(filePath, settled);
  return next;
}

interface AcquiredFileLock {
  assertOwned(): void;
  release(): Promise<void>;
}

function compromisedLockError(): WorkspaceRegistrationStoreError {
  return new WorkspaceRegistrationStoreError(
    'Workspace registration store lock was compromised',
  );
}

async function acquireFileLock(filePath: string): Promise<AcquiredFileLock> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let compromised = false;
  const release = await lockfile.lock(filePath, {
    ...LOCK_OPTIONS,
    onCompromised: () => {
      compromised = true;
    },
  });
  return {
    assertOwned: () => {
      if (compromised) throw compromisedLockError();
    },
    release: async () => {
      try {
        await release();
      } catch (err) {
        if (!compromised) throw err;
      }
      if (compromised) throw compromisedLockError();
    },
  };
}

export class WorkspaceRegistrationStore {
  readonly filePath: string;

  constructor(
    readonly primaryWorkspace: string,
    qwenHome?: string,
  ) {
    validateWorkspacePath(primaryWorkspace, 'primaryWorkspace');
    this.filePath = getWorkspaceRegistrationStorePath(
      primaryWorkspace,
      qwenHome,
    );
  }

  async read(): Promise<WorkspaceRegistrationSnapshot> {
    try {
      const entry = await fs.lstat(this.filePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new WorkspaceRegistrationStoreError(
          'Workspace registration store must be a regular file',
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptySnapshot(this.primaryWorkspace);
      }
      throw err;
    }
    let file: Awaited<ReturnType<typeof fs.open>>;
    try {
      file = await fs.open(
        this.filePath,
        (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptySnapshot(this.primaryWorkspace);
      }
      if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new WorkspaceRegistrationStoreError(
          'Workspace registration store must be a regular file',
        );
      }
      throw err;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        throw new WorkspaceRegistrationStoreError(
          'Workspace registration store must be a regular file',
        );
      }
      if (stat.size > MAX_STORE_BYTES) {
        throw new WorkspaceRegistrationStoreError(
          `Workspace registration store exceeds ${MAX_STORE_BYTES} bytes`,
        );
      }
      let buffer = Buffer.alloc(
        Math.max(1, Math.min(stat.size + 1, MAX_STORE_BYTES + 1)),
      );
      let totalBytesRead = 0;
      for (;;) {
        if (totalBytesRead === buffer.length) {
          if (totalBytesRead > MAX_STORE_BYTES) break;
          const grown = Buffer.alloc(
            Math.min(
              MAX_STORE_BYTES + 1,
              Math.max(buffer.length * 2, totalBytesRead + 1),
            ),
          );
          buffer.copy(grown, 0, 0, totalBytesRead);
          buffer = grown;
        }
        const { bytesRead } = await file.read(
          buffer,
          totalBytesRead,
          buffer.length - totalBytesRead,
          totalBytesRead,
        );
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      if (totalBytesRead > MAX_STORE_BYTES) {
        throw new WorkspaceRegistrationStoreError(
          `Workspace registration store exceeds ${MAX_STORE_BYTES} bytes`,
        );
      }
      return parseSnapshot(
        buffer.toString('utf8', 0, totalBytesRead),
        this.primaryWorkspace,
      );
    } finally {
      await file.close();
    }
  }

  async add(workspace: string): Promise<boolean> {
    validateWorkspacePath(workspace, 'workspace');
    if (
      normalizedScopePath(workspace) ===
      normalizedScopePath(this.primaryWorkspace)
    ) {
      throw new WorkspaceRegistrationStoreError(
        'Primary workspace cannot be stored as a secondary registration',
      );
    }
    return this.update((snapshot) => {
      if (snapshot.workspaces.includes(workspace)) return false;
      if (snapshot.workspaces.length >= MAX_SECONDARY_WORKSPACES) {
        throw new WorkspaceRegistrationStoreError(
          `Workspace registration store limit of ${MAX_SECONDARY_WORKSPACES} reached`,
        );
      }
      snapshot.workspaces.push(workspace);
      return true;
    });
  }

  async removeById(id: string): Promise<boolean> {
    return this.update((snapshot) => {
      const index = snapshot.workspaces.findIndex(
        (workspace) => workspaceRegistrationId(workspace) === id,
      );
      if (index < 0) return false;
      snapshot.workspaces.splice(index, 1);
      return true;
    });
  }

  private async update(
    mutate: (snapshot: WorkspaceRegistrationSnapshot) => boolean,
  ): Promise<boolean> {
    const { atomicWriteFile } = await import('@qwen-code/qwen-code-core');
    return withInProcessLock(this.filePath, async () => {
      const lock = await acquireFileLock(this.filePath);
      try {
        const snapshot = await this.read();
        lock.assertOwned();
        const changed = mutate(snapshot);
        if (!changed) return false;
        lock.assertOwned();
        await atomicWriteFile(
          this.filePath,
          `${JSON.stringify(snapshot, null, 2)}\n`,
          { mode: 0o600, forceMode: true, noFollow: true },
        );
        return true;
      } finally {
        await lock.release();
      }
    });
  }
}
