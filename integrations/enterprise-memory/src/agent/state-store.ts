/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const agentSessionStateSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    turnId: z.string().uuid().optional(),
    pendingOperationId: z.string().uuid().optional(),
  })
  .strict();

export interface AgentSessionState {
  sessionId: string;
  turnId?: string;
  pendingOperationId?: string;
}

export interface AgentOperation {
  operationId: string;
  state: AgentSessionState;
}

export class AgentStateStore {
  private directoryReady?: Promise<void>;

  constructor(
    private readonly directory: string,
    private readonly lockTimeoutMs = 5_000,
  ) {}

  async read(sessionId: string): Promise<AgentSessionState> {
    await this.ensureDirectory();
    try {
      const value = agentSessionStateSchema.parse(
        JSON.parse(await readFile(this.statePath(sessionId), 'utf8')),
      );
      if (value.sessionId !== sessionId) {
        throw new Error('Agent state session mismatch');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return { sessionId };
    }
  }

  async update(
    sessionId: string,
    mutate: (state: AgentSessionState) => AgentSessionState,
  ): Promise<AgentSessionState> {
    await this.ensureDirectory();
    const lockPath = `${this.statePath(sessionId)}.lock`;
    const lock = await this.acquireLock(lockPath);
    try {
      const next = agentSessionStateSchema.parse(
        mutate(await this.read(sessionId)),
      );
      const temporaryPath = `${this.statePath(sessionId)}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(next), { mode: 0o600 });
      await rename(temporaryPath, this.statePath(sessionId));
      return next;
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async beginOperation(sessionId: string): Promise<string> {
    return (await this.beginOperationWithState(sessionId)).operationId;
  }

  async beginOperationWithState(sessionId: string): Promise<AgentOperation> {
    const operationId = randomUUID();
    const state = await this.update(sessionId, (current) => ({
      ...current,
      pendingOperationId: operationId,
    }));
    return { operationId, state };
  }

  async completeOperation(
    sessionId: string,
    operationId: string,
  ): Promise<void> {
    await this.update(sessionId, (state) => ({
      ...state,
      pendingOperationId:
        state.pendingOperationId === operationId
          ? undefined
          : state.pendingOperationId,
    }));
  }

  private async acquireLock(lockPath: string) {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        try {
          await lock.writeFile(String(process.pid));
          return lock;
        } catch (error) {
          await lock.close();
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        if (await removeLockForExitedOwner(lockPath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for agent session lock');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    this.directoryReady ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
    })();
    await this.directoryReady;
  }

  private statePath(sessionId: string): string {
    const name = createHash('sha256').update(sessionId).digest('hex');
    return path.join(this.directory, `${name}.json`);
  }
}

async function removeLockForExitedOwner(lockPath: string): Promise<boolean> {
  const recoveryPath = `${lockPath}.recovery`;
  let recovery: Awaited<ReturnType<typeof open>>;
  try {
    recovery = await open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    let ownerText: string;
    try {
      ownerText = await readFile(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
    const owner = Number.parseInt(ownerText, 10);
    if (!Number.isSafeInteger(owner) || owner <= 0) {
      return false;
    }
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return false;
      }
      await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') {
          throw unlinkError;
        }
      });
      return true;
    }
  } finally {
    await recovery.close();
    await unlink(recoveryPath).catch(() => undefined);
  }
}
