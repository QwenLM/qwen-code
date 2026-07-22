/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

const agentSessionStateSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    turnId: z.string().uuid().optional(),
    pendingOperationId: z.string().uuid().optional(),
    recentOperations: z
      .array(
        z
          .object({
            operationId: z.string().uuid(),
            turnId: z.string().uuid().optional(),
            occurredAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(2_048)
      .default([]),
  })
  .strict();

interface RecentAgentOperation {
  operationId: string;
  turnId?: string;
  occurredAt: string;
}

export interface AgentSessionState {
  sessionId: string;
  turnId?: string;
  pendingOperationId?: string;
  recentOperations?: RecentAgentOperation[];
}

export interface AgentOperation {
  operationId: string;
  turnId?: string;
  occurredAt: string;
}

export class AgentStateStore {
  private directoryReady?: Promise<void>;
  private operationKey?: Promise<Buffer>;

  constructor(
    private readonly directory: string,
    private readonly lockTimeoutMs = 250,
    operationKey?: Uint8Array,
  ) {
    if (
      !Number.isSafeInteger(lockTimeoutMs) ||
      lockTimeoutMs < 50 ||
      lockTimeoutMs > 5_000
    ) {
      throw new Error('Agent state lock timeout is invalid');
    }
    if (operationKey && operationKey.byteLength !== 32) {
      throw new Error('Agent operation key is invalid');
    }
    if (operationKey) {
      this.operationKey = Promise.resolve(Buffer.from(operationKey));
    }
  }

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
      return { sessionId, recentOperations: [] };
    }
  }

  async update(
    sessionId: string,
    mutate: (state: AgentSessionState) => AgentSessionState,
  ): Promise<AgentSessionState> {
    await this.ensureDirectory();
    const release = await this.acquireLock(this.statePath(sessionId));
    try {
      const next = agentSessionStateSchema.parse(
        mutate(await this.read(sessionId)),
      );
      const temporaryPath = `${this.statePath(sessionId)}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(next), { mode: 0o600 });
      await rename(temporaryPath, this.statePath(sessionId));
      return next;
    } finally {
      await release();
    }
  }

  async beginOperation(
    sessionId: string,
    idempotencyInput: unknown,
  ): Promise<string> {
    return (await this.beginOperationWithState(sessionId, idempotencyInput))
      .operationId;
  }

  async beginOperationWithState(
    sessionId: string,
    idempotencyInput: unknown,
  ): Promise<AgentOperation> {
    const operationId = deterministicOperationId(
      await this.getOperationKey(),
      sessionId,
      idempotencyInput,
    );
    let operation: RecentAgentOperation | undefined;
    await this.update(sessionId, (current) => {
      const recent = current.recentOperations ?? [];
      operation = recent.find((item) => item.operationId === operationId);
      if (!operation) {
        operation = {
          operationId,
          turnId: current.turnId,
          occurredAt: new Date().toISOString(),
        };
      }
      return {
        ...current,
        pendingOperationId: operationId,
        recentOperations: recent.some(
          (item) => item.operationId === operationId,
        )
          ? recent
          : [...recent, operation].slice(-2_048),
      };
    });
    if (!operation) {
      throw new Error('Agent operation metadata was not persisted');
    }
    return {
      operationId,
      turnId: operation.turnId,
      occurredAt: operation.occurredAt,
    };
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

  private async acquireLock(statePath: string): Promise<() => Promise<void>> {
    const staleLockMs = Math.max(10_000, this.lockTimeoutMs * 5);
    try {
      return await lockfile.lock(statePath, {
        realpath: false,
        stale: staleLockMs,
        update: Math.floor(staleLockMs / 2),
        retries: {
          retries: 1_000,
          minTimeout: 10,
          maxTimeout: 100,
          factor: 1.2,
          randomize: true,
          maxRetryTime: this.lockTimeoutMs,
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
        throw new Error('Timed out waiting for agent session lock');
      }
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.directoryReady) {
      const pending = (async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
      })();
      this.directoryReady = pending;
      void pending.catch(() => {
        if (this.directoryReady === pending) {
          this.directoryReady = undefined;
        }
      });
    }
    await this.directoryReady;
  }

  private async getOperationKey(): Promise<Buffer> {
    await this.ensureDirectory();
    if (!this.operationKey) {
      const pending = (async () => {
        const keyPath = path.join(this.directory, '.operation-key');
        const release = await this.acquireLock(keyPath);
        try {
          try {
            const existing = await readFile(keyPath);
            if (existing.byteLength !== 32) {
              throw new Error('Agent operation key is invalid');
            }
            await chmod(keyPath, 0o600);
            return existing;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
          }
          const generated = randomBytes(32);
          await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 });
          return generated;
        } finally {
          await release();
        }
      })();
      this.operationKey = pending;
      void pending.catch(() => {
        if (this.operationKey === pending) {
          this.operationKey = undefined;
        }
      });
    }
    return this.operationKey;
  }

  private statePath(sessionId: string): string {
    const name = createHash('sha256').update(sessionId).digest('hex');
    return path.join(this.directory, `${name}.json`);
  }
}

function deterministicOperationId(
  key: Uint8Array,
  sessionId: string,
  idempotencyInput: unknown,
): string {
  const bytes = createHmac('sha256', key)
    .update(
      JSON.stringify([
        'enterprise-memory-agent-operation-v1',
        sessionId,
        idempotencyInput,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
