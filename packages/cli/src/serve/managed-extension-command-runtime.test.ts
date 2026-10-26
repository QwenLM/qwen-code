/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';
import {
  ManagedExtensionCommandRuntime,
  type ManagedExtensionCommand,
  type ManagedExtensionCommandDependencies,
} from './managed-extension-command-runtime.js';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-command-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function operation(): ManagedExtensionCommand {
  const operationId = `command-step-${'a'.repeat(64)}`;
  return {
    kind: 'extension-command',
    operationId,
    action: 'execute',
    toolName: 'shell',
    input: { command: 'echo hello' },
    revision: 1,
    extensionId: 'ext_00000000-0000-4000-8000-000000000001',
    grant: {
      sessionKey: {
        tenantId: 'tenant',
        workspaceId: 'workspace',
        sessionId: 'harness',
      },
      operationId,
      domain: 'tool_stage',
      operationRevision: 2,
      ownerId: 'runtime-session',
      workspaceGeneration: '1',
      resourceScope: {
        recordRef: {
          resourceId: 'record',
          kind: 'managed-tool_stage',
          schemaVersion: 1,
          byteLength: 2,
          digest: 'b'.repeat(64),
        },
        phases: ['execute', 'status', 'cancel'],
      },
      leaseDurationMs: 60_000,
      expiresAt: Date.now() + 60_000,
    },
  };
}

function dependencies(): ManagedExtensionCommandDependencies {
  return {
    directory,
    tenantId: 'tenant',
    workspaceId: 'workspace',
    workspaceGeneration: '1',
    prepareInput: vi.fn(async (_id, command) => command.input),
    execute: vi.fn(
      async (): Promise<ManagedToolResultPayload> => ({
        executionStatus: 'success',
        responseParts: [{ text: 'hello' }],
      }),
    ),
    cancel: vi.fn(),
  };
}

describe('Managed extension command durable execution', () => {
  it('persists a result before exposing settlement and never repeats a lost response', async () => {
    const deps = dependencies();
    const runtime = new ManagedExtensionCommandRuntime(deps);
    const command = operation();
    expect(await runtime.control('runtime-session', command)).toMatchObject({
      state: 'running',
    });
    await vi.waitFor(async () => {
      expect(
        await runtime.control('runtime-session', {
          ...command,
          action: 'status',
        }),
      ).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'success' },
      });
    });
    const restarted = new ManagedExtensionCommandRuntime(deps);
    expect(await restarted.control('runtime-session', command)).toMatchObject({
      state: 'settled',
    });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await expect(
      restarted.control('runtime-session', {
        ...command,
        input: { command: 'touch other' },
      }),
    ).rejects.toThrow('identity');
  });

  it('holds a surviving intent on restart and refuses to redispatch it', async () => {
    const deps = dependencies();
    let finish!: (value: ManagedToolResultPayload) => void;
    vi.mocked(deps.execute).mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const original = new ManagedExtensionCommandRuntime(deps);
    const command = operation();
    await original.control('runtime-session', command);
    await vi.waitFor(() => expect(deps.execute).toHaveBeenCalledTimes(1));
    const replacement = new ManagedExtensionCommandRuntime(deps);
    expect(await replacement.control('runtime-session', command)).toMatchObject(
      { state: 'outcome_unknown' },
    );
    expect(
      await replacement.control('runtime-session', {
        ...command,
        action: 'cancel',
      }),
    ).toMatchObject({ state: 'outcome_unknown' });
    expect(deps.execute).toHaveBeenCalledTimes(1);
    finish({ executionStatus: 'success', responseParts: [] });
    await vi.waitFor(async () =>
      expect(
        await original.control('runtime-session', {
          ...command,
          action: 'status',
        }),
      ).toMatchObject({ state: 'settled' }),
    );
  });

  it('never creates an execution during status or under another owner or expired grant', async () => {
    const deps = dependencies();
    const runtime = new ManagedExtensionCommandRuntime(deps);
    const command = operation();
    expect(
      await runtime.control('runtime-session', {
        ...command,
        action: 'status',
      }),
    ).toMatchObject({ state: 'outcome_unknown' });
    await expect(runtime.control('other', command)).rejects.toThrow('owner');
    await expect(
      runtime.control('runtime-session', {
        ...command,
        grant: { ...command.grant, expiresAt: Date.now() - 1 },
      }),
    ).rejects.toThrow();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('cancels preparation before it can start a tool', async () => {
    const deps = dependencies();
    let finish!: (input: Record<string, unknown>) => void;
    vi.mocked(deps.prepareInput).mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new ManagedExtensionCommandRuntime(deps);
    const command = operation();
    await runtime.control('runtime-session', command);
    await vi.waitFor(() => expect(deps.prepareInput).toHaveBeenCalledTimes(1));
    await runtime.control('runtime-session', { ...command, action: 'cancel' });
    finish(command.input);
    await vi.waitFor(async () =>
      expect(
        await runtime.control('runtime-session', {
          ...command,
          action: 'status',
        }),
      ).toMatchObject({
        state: 'settled',
        result: { executionStatus: 'not_started' },
      }),
    );
    expect(deps.execute).not.toHaveBeenCalled();
  });
});
