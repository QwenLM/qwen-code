/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  unregisterSessionModel,
  unregisterSessionProjectDir,
} from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import type { AnyDeclarativeTool } from '@qwen-code/qwen-code-core/tools/tools.js';
import { managedToolDigest } from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import {
  ManagedToolExecutor,
  ManagedToolConflictError,
  ManagedToolInvalidError,
  ManagedToolUnavailableError,
  relativizeGlobText,
  type ManagedShellCapturePublisher,
  type ManagedShellCaptureSink,
  type ManagedToolSet,
} from './managed-runtime-tool-executor.js';
import type { ToolResultEnvelope } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import {
  parseManagedCsiBoot,
  ManagedCsiAckRequestError,
  parseManagedCsiAckRequest,
  type ManagedCsiAckRequest,
  type ManagedCsiAckResponse,
  type ManagedCsiBoot,
  type ManagedCsiPodIdentity,
} from './managed-csi-envelope.js';
import { ManagedMcpRuntime } from './managed-mcp-runtime.js';
import { ManagedHookRuntime } from './managed-hook-runtime.js';
import { ManagedRuntimeFileHistory } from './managed-runtime-file-history.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

const input = { command: 'fixture' };
const reference = {
  sessionId: 'runtime-session-a',
  promptId: 'turn-a',
  callId: 'call-a',
  argsDigest: managedToolDigest(input),
};
const capture = {
  tenantId: 'tenant-a',
  sessionId: 'session-a',
  turnId: 'turn-a',
  executionCallId: 'execution-a',
  bindingGeneration: '1',
  capturePolicy: 'complete_required' as const,
};
const retirementId = '550e8400-e29b-41d4-a716-446655440000';

afterEach(() => vi.restoreAllMocks());

describe('Managed Tool worker admission seal', () => {
  it('seals the same Hook runtime and keeps its lifecycle blocker after close', async () => {
    const sessionKey = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    };
    const pin = {
      catalogId: 'hooks',
      catalogRevision: 1,
      definitionDigest: 'a'.repeat(64),
    };
    const hooks = new ManagedHookRuntime(
      { ...sessionKey, workspaceGeneration: '1' },
      async () => '/fixture',
      {
        version: 1,
        catalogs: [
          {
            ...pin,
            tenantId: sessionKey.tenantId,
            workspaceId: sessionKey.workspaceId,
            hooks: [],
          },
        ],
      },
    );
    const executor = new ManagedToolExecutor(
      async () => undefined,
      undefined,
      undefined,
      hooks,
    );
    const catalog = {
      kind: 'hook-catalog',
      sessionKey,
      operationId: 'catalog',
      pin,
    };
    await hooks.control('runtime-session', catalog);
    const seal = vi.spyOn(hooks, 'sealAdmission');
    executor.sealAdmission(retirementId);
    expect(seal).toHaveBeenCalledOnce();
    expect(executor.getDrainObservation(retirementId)).toMatchObject({
      workState: 'BLOCKED',
      blockers: ['hook_lifecycle_unqualified'],
      pendingStarts: 0,
      pendingInvocations: 0,
    });
    await expect(
      hooks.control('runtime-session', { ...catalog, operationId: 'new' }),
    ).rejects.toThrow('managed_hook_closed');
    await executor.close();
    expect(executor.getDrainObservation(retirementId).blockers).toContain(
      'hook_lifecycle_unqualified',
    );
  });

  it('pins a canonical retirement UUID and never reports durable completion', () => {
    const executor = new ManagedToolExecutor(async () => undefined);
    expect(() => executor.getDrainObservation(retirementId)).toThrow(
      ManagedToolConflictError,
    );
    for (const invalid of ['', retirementId.toUpperCase(), 'retirement-a'])
      expect(() => executor.sealAdmission(invalid)).toThrow(
        ManagedToolInvalidError,
      );
    expect(executor.isAdmissionOpen).toBe(true);
    executor.sealAdmission(retirementId);
    executor.sealAdmission(retirementId);
    expect(executor.isAdmissionOpen).toBe(false);
    expect(() =>
      executor.sealAdmission('550e8400-e29b-41d4-a716-446655440001'),
    ).toThrow(ManagedToolConflictError);
    expect(() =>
      executor.getDrainObservation('550e8400-e29b-41d4-a716-446655440001'),
    ).toThrow(ManagedToolConflictError);
    expect(executor.getDrainObservation(retirementId)).toEqual({
      state: 'DRAINING',
      workState: 'QUIESCENT',
      pendingStarts: 0,
      pendingInvocations: 0,
      blockers: [],
    });
  });

  it.each(['v2-lookup', 'v3-lookup', 'v3-capture'] as const)(
    'refuses a parked %s after seal with zero invocation starts',
    async (point) => {
      const entered = deferred();
      const gate = deferred();
      const build = vi.fn();
      const tools: ManagedToolSet = {
        sessionId: reference.sessionId,
        admitsDirectory: () => true,
        tools: new Map([
          [
            'run_shell_command',
            {
              validateToolParams: () => null,
              build,
            } as unknown as AnyDeclarativeTool,
          ],
        ]),
      };
      const prepare = vi.fn(async () => {
        if (point === 'v3-capture') {
          entered.resolve();
          await gate.promise;
        }
        return { identity: {}, sink: {} } as Awaited<
          ReturnType<ManagedShellCapturePublisher['prepare']>
        >;
      });
      const executor = new ManagedToolExecutor(
        async () => {
          if (point !== 'v3-capture') {
            entered.resolve();
            await gate.promise;
          }
          return tools;
        },
        { prepare },
      );
      const request =
        point === 'v2-lookup'
          ? executor.execute(reference, 'run_shell_command', input)
          : executor.executeV3({
              reference,
              capture,
              toolName: 'run_shell_command',
              input,
            });
      const refused = request.catch((error: unknown) => error);
      await entered.promise;
      executor.sealAdmission(retirementId);
      expect(executor.getDrainObservation(retirementId).workState).toBe(
        point === 'v3-capture' ? 'BLOCKED' : 'PENDING',
      );
      gate.resolve();
      expect(await refused).toBeInstanceOf(ManagedToolUnavailableError);
      await flush();
      expect(build).not.toHaveBeenCalled();
      expect(executor.getDrainObservation(retirementId).pendingStarts).toBe(0);
      if (point === 'v3-capture')
        expect(executor.getDrainObservation(retirementId).blockers).toContain(
          'capture_preparation_unqualified',
        );
      expect(executor.statusV3(reference).state).toBe('unknown');
    },
  );

  it('observes the actual original result, preserving replay and cancellation', async () => {
    const entered = deferred();
    const gate = deferred();
    const execute = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      return { llmContent: 'original bytes', returnDisplay: 'original bytes' };
    });
    const resolver = vi.fn(async () => ({
      sessionId: reference.sessionId,
      admitsDirectory: () => true,
      tools: new Map([
        [
          'read_file',
          { build: () => ({ execute }) } as unknown as AnyDeclarativeTool,
        ],
      ]),
    }));
    const executor = new ManagedToolExecutor(resolver);
    const request = executor.execute(reference, 'read_file', {});
    await entered.promise;
    executor.sealAdmission(retirementId);
    const replay = executor.execute(reference, 'read_file', {});
    expect(executor.cancel(reference)?.state).toBe('cancel_requested');
    expect(executor.getDrainObservation(retirementId).workState).toBe(
      'PENDING',
    );
    await expect(
      executor.execute({ ...reference, callId: 'fresh' }, 'read_file', {}),
    ).rejects.toBeInstanceOf(ManagedToolUnavailableError);
    gate.resolve();
    const result = await request;
    expect(await replay).toEqual(result);
    await flush();
    expect(result.responseParts).toEqual([
      { type: 'text', text: 'original bytes' },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(executor.getDrainObservation(retirementId).workState).toBe(
      'QUIESCENT',
    );
  });

  it('reads and writes real text before observing quiescence', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-worker-seal-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(directory, 'global'),
    );
    const executor = ManagedToolExecutor.forWorkspace(
      directory,
      reference.sessionId,
    );
    try {
      const file_path = path.join(directory, 'actual.txt');
      expect(
        (
          await executor.execute(reference, 'write_file', {
            file_path,
            content: 'actual bytes\n',
          })
        ).executionStatus,
      ).toBe('success');
      const read = await executor.execute(
        { ...reference, callId: 'read' },
        'read_file',
        { file_path },
      );
      expect(read.executionStatus).toBe('success');
      expect(JSON.stringify(read.responseParts)).toContain('actual bytes');
      expect(await readFile(file_path, 'utf8')).toBe('actual bytes\n');
      await flush();
      executor.sealAdmission(retirementId);
      expect(executor.getDrainObservation(retirementId).workState).toBe(
        'QUIESCENT',
      );
      expect(
        (
          await executor.execute(reference, 'write_file', {
            file_path,
            content: 'actual bytes\n',
          })
        ).executionStatus,
      ).toBe('success');
      await expect(
        executor.execute(
          { ...reference, callId: 'fresh-write' },
          'write_file',
          { file_path, content: 'bad' },
        ),
      ).rejects.toBeInstanceOf(ManagedToolUnavailableError);
      expect(await readFile(file_path, 'utf8')).toBe('actual bytes\n');
    } finally {
      await executor.close();
      unregisterSessionModel(reference.sessionId);
      unregisterSessionProjectDir(reference.sessionId);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    'unknown',
    'partial',
    'uncommitted',
    'blocked',
    'committed',
  ] as const)(
    'retains %s capture blockers despite a fulfilled invocation',
    async (outcome) => {
      const finalize = vi.fn(async () => {
        if (outcome === 'unknown') throw new Error('publication failed');
        return {
          executionStatus: 'success',
          responseParts: [],
          capture: {
            captureStatus: outcome === 'partial' ? 'partial' : 'complete',
            deliveryStatus: outcome === 'blocked' ? 'blocked' : 'pending',
            manifest: {
              resourceId: 'manifest-a',
              kind: 'managed-tool-result-manifest',
              schemaVersion: 1,
              byteLength: 1,
              digest: `sha256:${'a'.repeat(64)}`,
            },
            previewTruncated: false,
          },
        };
      });
      const tools: ManagedToolSet = {
        sessionId: reference.sessionId,
        admitsDirectory: () => true,
        tools: new Map([
          [
            'run_shell_command',
            {
              validateToolParams: () => null,
              build: () => ({
                execute: async () => ({
                  llmContent: 'result',
                  returnDisplay: 'result',
                }),
              }),
            } as unknown as AnyDeclarativeTool,
          ],
        ]),
      };
      const executor = new ManagedToolExecutor(async () => tools, {
        prepare: async () =>
          ({ identity: {}, sink: { finalize } }) as unknown as Awaited<
            ReturnType<ManagedShellCapturePublisher['prepare']>
          >,
      });
      const request = {
        reference,
        capture,
        toolName: 'run_shell_command',
        input,
      };
      const original = await executor.executeV3(request);
      await flush();
      executor.sealAdmission(retirementId);
      expect(await executor.executeV3(request)).toEqual(original);
      if (outcome === 'committed') {
        expect(
          executor.acknowledgeV3(reference, {
            executionCallId: capture.executionCallId,
            manifest: original.result!.capture!.manifest,
            deliveryStatus: 'committed',
            historyRevision: 7,
          }).result?.capture?.deliveryStatus,
        ).toBe('committed');
      }
      const observed = executor.getDrainObservation(retirementId);
      expect(observed.workState).toBe('BLOCKED');
      expect(observed.blockers).toContain('shell_lifecycle_unqualified');
      if (outcome === 'unknown')
        expect(observed.blockers).toContain('execution_outcome_unknown');
      else if (outcome !== 'committed')
        expect(observed.blockers).toContain('capture_uncommitted');
      else expect(observed.blockers).not.toContain('capture_uncommitted');
      if (outcome === 'partial')
        expect(observed.blockers).toContain('capture_incomplete');
      await executor.close();
      expect(executor.getDrainObservation(retirementId).blockers).toContain(
        'shutdown_started',
      );
      expect(executor.getDrainObservation(retirementId).workState).toBe(
        'BLOCKED',
      );
    },
  );

  it('keeps completed ordinary Shell activity blocked after close', async () => {
    const executor = new ManagedToolExecutor(async () => ({
      sessionId: reference.sessionId,
      admitsDirectory: () => true,
      tools: new Map([
        [
          'run_shell_command',
          {
            validateToolParams: () => null,
            build: () => ({
              execute: async () => ({
                llmContent: 'shell result',
                returnDisplay: 'shell result',
              }),
            }),
          } as unknown as AnyDeclarativeTool,
        ],
      ]),
    }));
    await executor.execute(reference, 'run_shell_command', input);
    executor.sealAdmission(retirementId);
    expect(executor.getDrainObservation(retirementId).blockers).toContain(
      'shell_lifecycle_unqualified',
    );
    await executor.close();
    expect(executor.getDrainObservation(retirementId).blockers).toEqual([
      'shell_lifecycle_unqualified',
      'shutdown_started',
    ]);
  });

  it('keeps a provider claim blocked after unclaim and refuses a fresh claim', () => {
    const executor = new ManagedToolExecutor(async () => undefined);
    executor.claimProviderSession('provider-a');
    executor.unclaimProviderSession('provider-a');
    executor.sealAdmission(retirementId);
    expect(executor.getDrainObservation(retirementId).blockers).toContain(
      'provider_lifecycle_unqualified',
    );
    expect(() => executor.claimProviderSession('provider-b')).toThrow(
      ManagedToolConflictError,
    );
  });

  it('keeps original history snapshots without resolving a new Workspace', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-worker-history-seal-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(directory, 'global'),
    );
    const resolver = vi.fn(async () => ({
      sessionId: reference.sessionId,
      directory,
      admitsDirectory: () => true,
      tools: new Map(),
    }));
    const executor = new ManagedToolExecutor(resolver);
    try {
      const original = await executor.controlFileHistory(
        'owner-a',
        reference.sessionId,
        { kind: 'raw-file-history', action: 'bind', state: null },
      );
      executor.sealAdmission(retirementId);
      executor.closeSessionAdmission(reference.sessionId);
      expect(
        await executor.controlFileHistory('owner-a', reference.sessionId, {
          kind: 'raw-file-history',
          action: 'snapshot',
        }),
      ).toEqual(original);
      expect(resolver).toHaveBeenCalledTimes(1);
      await expect(
        executor.controlFileHistory('wrong-owner', reference.sessionId, {
          kind: 'raw-file-history',
          action: 'snapshot',
        }),
      ).rejects.toBeInstanceOf(ManagedToolConflictError);
      await expect(
        executor.controlFileHistory('owner-a', reference.sessionId, {
          kind: 'raw-file-history',
          action: 'prepare',
          promptId: 'turn-a',
          paths: [],
        }),
      ).rejects.toBeInstanceOf(ManagedToolUnavailableError);
      await executor.close();
      expect(
        await executor.controlFileHistory('owner-a', reference.sessionId, {
          kind: 'raw-file-history',
          action: 'snapshot',
        }),
      ).toEqual(original);
      expect(executor.getDrainObservation(retirementId).blockers).toContain(
        'shutdown_started',
      );
    } finally {
      await executor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a queued original file invocation at its actual start boundary', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-worker-queued-seal-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(directory, 'global'),
    );
    const entered = deferred();
    const gate = deferred();
    const execute = vi.fn(async () => ({
      llmContent: 'unexpected',
      returnDisplay: 'unexpected',
    }));
    const executor = new ManagedToolExecutor(async () => ({
      sessionId: reference.sessionId,
      directory,
      admitsDirectory: () => true,
      tools: new Map([
        [
          'write_file',
          { build: () => ({ execute }) } as unknown as AnyDeclarativeTool,
        ],
      ]),
    }));
    try {
      await executor.controlFileHistory('owner-a', reference.sessionId, {
        kind: 'raw-file-history',
        action: 'bind',
        state: null,
      });
      vi.spyOn(
        ManagedRuntimeFileHistory.prototype,
        'execute',
      ).mockImplementation(async (_file, action) => {
        entered.resolve();
        await gate.promise;
        return action();
      });
      const request = executor.execute(reference, 'write_file', {
        file_path: path.join(directory, 'output.txt'),
      });
      await entered.promise;
      executor.sealAdmission(retirementId);
      expect(executor.getDrainObservation(retirementId).workState).toBe(
        'PENDING',
      );
      gate.resolve();
      expect((await request).executionStatus).toBe('not_started');
      expect(execute).not.toHaveBeenCalled();
      expect(executor.status(reference)?.state).toBe('settled');
      await flush();
      expect(executor.getDrainObservation(retirementId).workState).toBe(
        'QUIESCENT',
      );
    } finally {
      gate.resolve();
      await executor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['prepare-throws', 'rewind-throws', 'rewind-failed-files'] as const)(
    'retains %s history uncertainty after its pending request ends',
    async (failure) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'qwen-worker-history-failure-'),
      );
      vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
        path.join(directory, 'global'),
      );
      const executor = new ManagedToolExecutor(async () => ({
        sessionId: reference.sessionId,
        directory,
        admitsDirectory: () => true,
        tools: new Map(),
      }));
      const marker = path.join(directory, 'partial-effect.txt');
      try {
        const original = await executor.controlFileHistory(
          'owner-a',
          reference.sessionId,
          { kind: 'raw-file-history', action: 'bind', state: null },
        );
        const mutate = async () => {
          await writeFile(marker, 'original mutation began');
          throw new Error('post-mutation history failure');
        };
        if (failure === 'prepare-throws')
          vi.spyOn(
            ManagedRuntimeFileHistory.prototype,
            'prepare',
          ).mockImplementation(mutate);
        else if (failure === 'rewind-throws')
          vi.spyOn(
            ManagedRuntimeFileHistory.prototype,
            'rewind',
          ).mockImplementation(mutate);
        else
          vi.spyOn(
            ManagedRuntimeFileHistory.prototype,
            'rewind',
          ).mockImplementation(async function (
            this: ManagedRuntimeFileHistory,
          ) {
            await writeFile(marker, 'original mutation began');
            return {
              state: this.state(),
              filesChanged: [],
              filesFailed: ['partial-effect.txt'],
              conflict: false,
            };
          });
        const request = executor.controlFileHistory(
          'owner-a',
          reference.sessionId,
          failure === 'prepare-throws'
            ? {
                kind: 'raw-file-history',
                action: 'prepare',
                promptId: 'turn-a',
                paths: [],
              }
            : {
                kind: 'raw-file-history',
                action: 'rewind',
                promptId: 'turn-a',
              },
        );
        if (failure === 'rewind-failed-files')
          expect(await request).toMatchObject({
            filesFailed: ['partial-effect.txt'],
          });
        else
          await expect(request).rejects.toThrow(
            'post-mutation history failure',
          );
        expect(await readFile(marker, 'utf8')).toBe('original mutation began');
        await flush();
        executor.sealAdmission(retirementId);
        expect(executor.getDrainObservation(retirementId)).toMatchObject({
          workState: 'BLOCKED',
          pendingStarts: 0,
          blockers: ['history_control_outcome_unknown'],
        });
        expect(
          await executor.controlFileHistory('owner-a', reference.sessionId, {
            kind: 'raw-file-history',
            action: 'snapshot',
          }),
        ).toEqual(original);
        executor.closeSessionAdmission(reference.sessionId);
        await executor.close();
        expect(executor.getDrainObservation(retirementId).blockers).toContain(
          'history_control_outcome_unknown',
        );
      } finally {
        await executor.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('Managed Tool executor shutdown', () => {
  it('refuses an original file-history snapshot during ordinary shutdown', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-worker-history-close-'),
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
      path.join(directory, 'global'),
    );
    const resolver = vi.fn(async () => ({
      sessionId: reference.sessionId,
      directory,
      admitsDirectory: () => true,
      tools: new Map(),
    }));
    const executor = new ManagedToolExecutor(resolver);
    try {
      await executor.controlFileHistory('owner-a', reference.sessionId, {
        kind: 'raw-file-history',
        action: 'bind',
        state: null,
      });
      await executor.close();
      expect(executor.isAdmissionSealed).toBe(false);
      await expect(
        executor.controlFileHistory('owner-a', reference.sessionId, {
          kind: 'raw-file-history',
          action: 'snapshot',
        }),
      ).rejects.toBeInstanceOf(ManagedToolUnavailableError);
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      await executor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['v2-lookup', 'v3-lookup', 'v3-capture'] as const)(
    'waits for %s before returning, without starting a tool',
    async (point) => {
      const entered = deferred();
      const gate = deferred();
      const build = vi.fn(() => {
        throw new Error('No tool may start after shutdown.');
      });
      const tools: ManagedToolSet = {
        sessionId: reference.sessionId,
        admitsDirectory: () => true,
        tools: new Map([
          [
            'run_shell_command',
            {
              validateToolParams: () => null,
              build,
            } as unknown as AnyDeclarativeTool,
          ],
        ]),
      };
      const prepare = vi.fn(async () => {
        if (point === 'v3-capture') {
          entered.resolve();
          await gate.promise;
        }
        return { identity: {}, sink: {} } as Awaited<
          ReturnType<ManagedShellCapturePublisher['prepare']>
        >;
      });
      const executor = new ManagedToolExecutor(
        async () => {
          if (point !== 'v3-capture') {
            entered.resolve();
            await gate.promise;
          }
          return tools;
        },
        { prepare },
      );
      const request =
        point === 'v2-lookup'
          ? executor.execute(reference, 'run_shell_command', input)
          : executor.executeV3({
              reference,
              capture,
              toolName: 'run_shell_command',
              input,
            });
      const refused = request.catch((error: unknown) => error);
      await entered.promise;
      let closed = false;
      const closing = executor.close().then(() => {
        closed = true;
      });
      try {
        await flush();
        expect(closed).toBe(false);
        expect(build).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
      }
      expect(await refused).toBeInstanceOf(ManagedToolUnavailableError);
      await closing;
      expect(closed).toBe(true);
      expect(build).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(point === 'v3-capture' ? 1 : 0);
      expect(executor.statusV3(reference).state).toBe('unknown');
    },
  );

  it('does not create a new MCP invocation after its lookup resumes during shutdown', async () => {
    const entered = deferred();
    const gate = deferred();
    const mcp = new ManagedMcpRuntime(
      {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        workspaceGeneration: '1',
      },
      async () => '/fixture',
      { version: 1, servers: [] },
    );
    const invoke = vi.spyOn(mcp, 'invokeTool');
    const executor = new ManagedToolExecutor(
      async () => {
        entered.resolve();
        await gate.promise;
        return {
          sessionId: reference.sessionId,
          admitsDirectory: () => true,
          tools: new Map(),
        };
      },
      undefined,
      mcp,
    );
    const request = executor.execute(reference, 'managed_mcp_call', {});
    const refused = request.catch((error: unknown) => error);
    await entered.promise;
    let closed = false;
    const closing = executor.close().then(() => {
      closed = true;
    });
    try {
      await flush();
      expect(closed).toBe(false);
    } finally {
      gate.resolve();
    }
    expect(await refused).toBeInstanceOf(ManagedToolUnavailableError);
    await closing;
    expect(invoke).not.toHaveBeenCalled();
    expect(executor.status(reference)).toBeNull();
  });

  it('waits for an admitted file-history lookup and does not initialize a history after shutdown', async () => {
    const entered = deferred();
    const gate = deferred();
    const ready = vi.spyOn(ManagedRuntimeFileHistory.prototype, 'ready');
    const executor = new ManagedToolExecutor(async () => {
      entered.resolve();
      await gate.promise;
      return {
        sessionId: reference.sessionId,
        directory: '/fixture',
        admitsDirectory: () => true,
        tools: new Map(),
      };
    });
    const request = executor.controlFileHistory(
      'session-a',
      reference.sessionId,
      { kind: 'raw-file-history', action: 'bind', state: null },
    );
    const refused = request.catch((error: unknown) => error);
    await entered.promise;
    let closed = false;
    const closing = executor.close().then(() => {
      closed = true;
    });
    try {
      await flush();
      expect(closed).toBe(false);
    } finally {
      gate.resolve();
    }
    expect(await refused).toBeInstanceOf(ManagedToolUnavailableError);
    await closing;
    expect(ready).not.toHaveBeenCalled();
  });

  it('aborts an original execution and waits for its terminal observation', async () => {
    const entered = deferred();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const tool = {
      build: () => ({
        execute: async (abort: AbortSignal) => {
          signal = abort;
          entered.resolve();
          await gate.promise;
          return {
            llmContent: 'original result',
            returnDisplay: 'original result',
          };
        },
      }),
    } as unknown as AnyDeclarativeTool;
    const executor = new ManagedToolExecutor(async () => ({
      sessionId: reference.sessionId,
      admitsDirectory: () => true,
      tools: new Map([['read_file', tool]]),
    }));
    const request = executor.execute(reference, 'read_file', {});
    await entered.promise;
    let closed = false;
    const closing = executor.close().then(() => {
      closed = true;
    });
    try {
      await flush();
      expect(signal?.aborted).toBe(true);
      expect(closed).toBe(false);
      expect(executor.status(reference)?.state).toBe('executing');
      await expect(
        executor.execute({ ...reference, callId: 'new-call' }, 'read_file', {}),
      ).rejects.toBeInstanceOf(ManagedToolUnavailableError);
    } finally {
      gate.resolve();
    }
    await request;
    await closing;
    expect(executor.status(reference)?.state).toBe('settled');
    expect(executor.status(reference)?.result?.responseParts).toEqual([
      { type: 'text', text: 'original result' },
    ]);
  });
});

const csiAckFixture = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-csi-worker-ack-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  boot: ManagedCsiBoot;
  expectedPod: ManagedCsiPodIdentity;
  input: Record<string, unknown>;
  request: ManagedCsiAckRequest;
  response: ManagedCsiAckResponse;
  capture: LocalShellCaptureRequest['capture'];
};

async function originalCsiExecutor(
  fixture = structuredClone(csiAckFixture),
  outcome:
    | 'complete'
    | 'partial'
    | 'blocked'
    | 'unknown'
    | 'missing_manifest'
    | 'not_started' = 'complete',
  beforeExecute?: () => Promise<void>,
  accept?: ManagedShellCapturePublisher['accept'],
) {
  const identity = { ...fixture.response.captureIdentity };
  const manifest = { ...fixture.request.acknowledgement.manifest };
  const finalize = vi.fn(async (): Promise<ToolResultEnvelope> => {
    if (outcome === 'unknown') throw new Error('capture failed');
    return {
      executionStatus: outcome === 'not_started' ? 'not_started' : 'success',
      responseParts: [],
      capture: {
        captureStatus: outcome === 'partial' ? 'partial' : 'complete',
        captureReason: outcome === 'partial' ? 'storage_failed' : null,
        manifest: outcome === 'missing_manifest' ? null : manifest,
        deliveryStatus: outcome === 'blocked' ? 'blocked' : 'pending',
        previewTruncated: false,
      },
    };
  });
  const execute = vi.fn(async () => {
    await beforeExecute?.();
    return { llmContent: 'original result', returnDisplay: 'original result' };
  });
  const resolver = vi.fn(async () => ({
    sessionId: fixture.request.reference.sessionId,
    admitsDirectory: () => true,
    tools: new Map([
      [
        'run_shell_command',
        {
          validateToolParams: () => null,
          build: () => ({ execute }),
        } as unknown as AnyDeclarativeTool,
      ],
    ]),
  }));
  const sink = { identity, finalize } as unknown as ManagedShellCaptureSink;
  const prepare = vi.fn(async () => ({
    identity: { ...identity, captureId: 'unused-prepared-id' },
    sink,
  }));
  const executor = new ManagedToolExecutor(resolver, {
    prepare,
    hasInstalledPublication: true,
    ...(accept ? { accept } : {}),
  });
  const resultPromise = executor.executeV3({
    reference: fixture.request.reference,
    capture: fixture.capture,
    toolName: 'run_shell_command',
    input: fixture.input,
  });
  if (!beforeExecute) await resultPromise;
  return {
    fixture,
    executor,
    identity,
    manifest,
    sink,
    resolver,
    prepare,
    execute,
    finalize,
    resultPromise,
  };
}

describe('original CSI worker synchronous ACK confirmation', () => {
  it('confirms the actual sink identity, preserves lifecycle blockers and never starts new work', async () => {
    const original = await originalCsiExecutor();
    const { executor, fixture } = original;
    const boot = parseManagedCsiBoot(fixture.boot);
    executor.sealAdmission(fixture.request.retirementId);
    const before = executor.getDrainObservation(fixture.request.retirementId);
    const confirmed = executor.acknowledgeOriginalCsi(
      fixture.request,
      boot,
      fixture.expectedPod,
    );
    expect(confirmed.response).toEqual(fixture.response);
    expect(JSON.parse(confirmed.json)).toEqual(confirmed.response);
    expect(confirmed.response.captureIdentity.captureId).toBe(
      original.sink.identity.captureId,
    );
    expect(confirmed.response.captureIdentity.sessionId).not.toBe(
      fixture.request.reference.sessionId,
    );
    expect(confirmed.response.captureIdentity.turnId).not.toBe(
      fixture.request.reference.promptId,
    );
    expect(
      executor.statusV3(fixture.request.reference).result?.capture
        ?.deliveryStatus,
    ).toBe('committed');
    expect(
      executor.acknowledgeOriginalCsi(
        fixture.request,
        boot,
        fixture.expectedPod,
      ),
    ).toEqual(confirmed);
    const after = executor.getDrainObservation(fixture.request.retirementId);
    expect(before.blockers).toContain('capture_uncommitted');
    expect(after.blockers).not.toContain('capture_uncommitted');
    expect(after.workState).toBe('BLOCKED');
    for (const blocker of [
      'shell_lifecycle_unqualified',
      'capture_preparation_unqualified',
      'publication_lifecycle_unqualified',
    ])
      expect(after.blockers).toContain(blocker);
    expect(original.resolver).toHaveBeenCalledTimes(1);
    expect(original.prepare).toHaveBeenCalledTimes(1);
    expect(original.execute).toHaveBeenCalledTimes(1);
    expect(original.finalize).toHaveBeenCalledTimes(1);
    expect(confirmed.json).not.toContain(boot.context.token);
  });

  it('accepts semantically equal reordered first ACK and preserves the original manifest order', async () => {
    const { executor, fixture, manifest } = await originalCsiExecutor();
    const reorderedManifest = Object.fromEntries(
      Object.entries(manifest).reverse(),
    );
    const request = parseManagedCsiAckRequest(
      {
        ...fixture.request,
        acknowledgement: {
          ...fixture.request.acknowledgement,
          manifest: reorderedManifest,
        },
      },
      fixture.boot,
      fixture.expectedPod,
    );
    executor.sealAdmission(request.retirementId);
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    expect(
      executor.acknowledgeOriginalCsi(
        request,
        fixture.boot,
        fixture.expectedPod,
      ).response,
    ).toEqual(fixture.response);
    expect(setter.mock.calls[0][1].manifest).toBe(manifest);
    expect(Object.keys(manifest)).toEqual(
      Object.keys(fixture.request.acknowledgement.manifest),
    );
  });

  it('replays an earlier ordinary ACK using its unchanged stored object and property order', async () => {
    const { executor, fixture, manifest } = await originalCsiExecutor();
    const receipt = {
      historyRevision: 7,
      deliveryStatus: 'committed' as const,
      manifest,
      executionCallId: fixture.capture.executionCallId,
    };
    executor.acknowledgeV3(fixture.request.reference, receipt);
    executor.sealAdmission(fixture.request.retirementId);
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    expect(
      executor.acknowledgeOriginalCsi(
        fixture.request,
        fixture.boot,
        fixture.expectedPod,
      ).response,
    ).toEqual(fixture.response);
    expect(setter).not.toHaveBeenCalled();
    expect(Object.keys(receipt)).toEqual([
      'historyRevision',
      'deliveryStatus',
      'manifest',
      'executionCallId',
    ]);
    expect(() =>
      executor.acknowledgeOriginalCsi(
        {
          ...fixture.request,
          acknowledgement: {
            ...fixture.request.acknowledgement,
            historyRevision: 8,
          },
        },
        fixture.boot,
        fixture.expectedPod,
      ),
    ).toThrow(ManagedCsiAckRequestError);
  });

  it('confirms a semantically identical automatic accept receipt without rewriting its manifest order', async () => {
    const receipt = {
      ...csiAckFixture.request.acknowledgement,
      outcomeRef: {
        resourceId: 'outcome-a',
        kind: 'managed-tool-outcome',
        schemaVersion: 1,
        byteLength: 512,
        digest: 'c'.repeat(64),
      },
      manifest: Object.fromEntries(
        Object.entries(
          csiAckFixture.request.acknowledgement.manifest,
        ).reverse(),
      ) as ManagedCsiAckRequest['acknowledgement']['manifest'],
    };
    const accept = vi.fn(async () => receipt);
    const { executor, fixture, manifest } = await originalCsiExecutor(
      undefined,
      'complete',
      undefined,
      accept,
    );
    expect(
      executor.statusV3(fixture.request.reference).result?.capture
        ?.deliveryStatus,
    ).toBe('committed');
    expect(() =>
      executor.acknowledgeV3(fixture.request.reference, receipt),
    ).toThrow(ManagedToolConflictError);
    executor.sealAdmission(fixture.request.retirementId);
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    expect(
      executor.acknowledgeOriginalCsi(
        fixture.request,
        fixture.boot,
        fixture.expectedPod,
      ).response,
    ).toEqual(fixture.response);
    expect(setter).not.toHaveBeenCalled();
    expect(Object.keys(receipt.manifest)).toEqual(
      Object.keys(fixture.request.acknowledgement.manifest).reverse(),
    );
    expect(Object.keys(manifest)).toEqual(
      Object.keys(fixture.request.acknowledgement.manifest),
    );
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it.each([
    'partial',
    'blocked',
    'unknown',
    'missing_manifest',
    'not_started',
  ] as const)('refuses original %s without writing an ACK', async (outcome) => {
    const { executor, fixture } = await originalCsiExecutor(undefined, outcome);
    executor.sealAdmission(fixture.request.retirementId);
    const before = executor.statusV3(fixture.request.reference);
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    expect(() =>
      executor.acknowledgeOriginalCsi(
        fixture.request,
        fixture.boot,
        fixture.expectedPod,
      ),
    ).toThrow(ManagedCsiAckRequestError);
    expect(setter).not.toHaveBeenCalled();
    expect(executor.statusV3(fixture.request.reference)).toEqual(before);
  });

  it.each([
    'tenantId',
    'sessionId',
    'turnId',
    'executionCallId',
    'bindingGeneration',
    'callId',
    'invocationDigest',
    'captureId',
    'revision',
  ] as const)('refuses damaged actual capture identity %s', async (field) => {
    const { executor, fixture, identity } = await originalCsiExecutor();
    const damaged = identity as unknown as Record<string, unknown>;
    damaged[field] =
      field === 'revision'
        ? 2
        : field === 'bindingGeneration'
          ? '10'
          : field === 'invocationDigest'
            ? 'c'.repeat(64)
            : field === 'captureId'
              ? 'INVALID'
              : 'crossed-original';
    executor.sealAdmission(fixture.request.retirementId);
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    expect(() =>
      executor.acknowledgeOriginalCsi(
        fixture.request,
        fixture.boot,
        fixture.expectedPod,
      ),
    ).toThrow(ManagedCsiAckRequestError);
    expect(setter).not.toHaveBeenCalled();
    expect(
      executor.statusV3(fixture.request.reference).result?.capture
        ?.deliveryStatus,
    ).toBe('pending');
  });

  it('refuses an unsealed, missing, restarted or v2 entry without treating absence as confirmation', async () => {
    const { executor, fixture } = await originalCsiExecutor();
    const confirm = (worker: ManagedToolExecutor, request = fixture.request) =>
      worker.acknowledgeOriginalCsi(request, fixture.boot, fixture.expectedPod);
    expect(() => confirm(executor)).toThrow(ManagedCsiAckRequestError);
    executor.sealAdmission(fixture.request.retirementId);
    expect(() =>
      confirm(executor, {
        ...fixture.request,
        retirementId: '550e8400-e29b-41d4-a716-446655440001',
      }),
    ).toThrow(ManagedCsiAckRequestError);
    for (const field of ['sessionId', 'promptId', 'callId'] as const)
      expect(() =>
        confirm(executor, {
          ...fixture.request,
          reference: { ...fixture.request.reference, [field]: 'replacement' },
        }),
      ).toThrow(ManagedCsiAckRequestError);
    expect(() =>
      confirm(executor, {
        ...fixture.request,
        acknowledgement: {
          ...fixture.request.acknowledgement,
          executionCallId: 'replacement',
        },
      }),
    ).toThrow(ManagedCsiAckRequestError);
    const restarted = new ManagedToolExecutor(async () => undefined);
    restarted.sealAdmission(fixture.request.retirementId);
    expect(() => confirm(restarted)).toThrow(ManagedCsiAckRequestError);
    const v2 = new ManagedToolExecutor(async () => ({
      sessionId: fixture.request.reference.sessionId,
      admitsDirectory: () => true,
      tools: new Map([
        [
          'read_file',
          {
            build: () => ({
              execute: async () => ({ llmContent: 'v2', returnDisplay: 'v2' }),
            }),
          } as unknown as AnyDeclarativeTool,
        ],
      ]),
    }));
    await v2.execute(fixture.request.reference, 'read_file', {});
    v2.sealAdmission(fixture.request.retirementId);
    expect(() => confirm(v2)).toThrow(ManagedCsiAckRequestError);
  });

  it('refuses executing and cancel_requested original entries then allows their real settled result', async () => {
    const entered = deferred();
    const gate = deferred();
    const { executor, fixture, resultPromise } = await originalCsiExecutor(
      undefined,
      'complete',
      async () => {
        entered.resolve();
        await gate.promise;
      },
    );
    await entered.promise;
    executor.sealAdmission(fixture.request.retirementId);
    expect(executor.statusV3(fixture.request.reference).state).toBe(
      'executing',
    );
    const confirm = () =>
      executor.acknowledgeOriginalCsi(
        fixture.request,
        fixture.boot,
        fixture.expectedPod,
      );
    expect(confirm).toThrow(ManagedCsiAckRequestError);
    expect(executor.cancelV3(fixture.request.reference).state).toBe(
      'cancel_requested',
    );
    expect(confirm).toThrow(ManagedCsiAckRequestError);
    gate.resolve();
    await resultPromise;
    expect(executor.statusV3(fixture.request.reference).state).toBe('settled');
    expect(confirm().response.state).toBe('ACKNOWLEDGED');
  });

  it('refuses a complete prospective response over 16 KiB before the generic ACK setter', async () => {
    const fixture = structuredClone(csiAckFixture);
    fixture.boot = {
      ...fixture.boot,
      context: { ...fixture.boot.context, mountRoot: '/' + '"'.repeat(2047) },
    };
    fixture.boot = {
      ...fixture.boot,
      storage: {
        ...fixture.boot.storage,
        clusterDomain: '界'.repeat(256),
        backendDomain: '界'.repeat(256),
        volumeHandle: '界'.repeat(512),
        pvcUid: '界'.repeat(128),
        pvUid: '界'.repeat(128),
      },
    };
    const hash = createHash('sha256');
    for (const field of [
      'qwen-csi-physical/1',
      fixture.boot.storage.backendDomain,
      fixture.boot.storage.driver,
      fixture.boot.storage.volumeHandle,
    ]) {
      const bytes = Buffer.from(field);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(bytes.length);
      hash.update(size).update(bytes);
    }
    fixture.boot = {
      ...fixture.boot,
      storage: { ...fixture.boot.storage, physicalKey: hash.digest('hex') },
    };
    const boot = parseManagedCsiBoot(fixture.boot);
    const longId = '\\'.repeat(512);
    fixture.request = {
      ...fixture.request,
      context: {
        ...fixture.request.context,
        mountRoot: boot.context.mountRoot,
      },
      storage: boot.storage,
      reference: {
        ...fixture.request.reference,
        sessionId: longId,
        promptId: longId,
        callId: longId,
      },
      acknowledgement: {
        ...fixture.request.acknowledgement,
        executionCallId: longId,
        manifest: {
          ...fixture.request.acknowledgement.manifest,
          resourceId: longId,
        },
      },
    };
    fixture.capture = {
      ...fixture.capture,
      sessionId: longId,
      turnId: longId,
      executionCallId: longId,
    };
    fixture.response = {
      ...fixture.request,
      state: 'ACKNOWLEDGED',
      captureIdentity: {
        ...fixture.response.captureIdentity,
        sessionId: longId,
        turnId: longId,
        executionCallId: longId,
        callId: longId,
      },
    };
    expect(
      Buffer.byteLength(JSON.stringify(fixture.request)),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(fixture.response))).toBeGreaterThan(
      16 * 1024,
    );
    const { executor } = await originalCsiExecutor(fixture);
    executor.sealAdmission(fixture.request.retirementId);
    const setter = vi.spyOn(executor, 'acknowledgeV3');
    const before = executor.statusV3(fixture.request.reference);
    expect(() =>
      executor.acknowledgeOriginalCsi(
        fixture.request,
        boot,
        fixture.expectedPod,
      ),
    ).toThrow(ManagedCsiAckRequestError);
    expect(setter).not.toHaveBeenCalled();
    expect(executor.statusV3(fixture.request.reference)).toEqual(before);
  });
});

// The route-level fixtures cannot express these geometries (a Session root is
// always a deep unique tmpdir path), so the anchoring invariants are pinned
// against the function directly.
describe('relativizeGlobText', () => {
  it('strips the root at token starts but keeps a tail that repeats it', () => {
    // The hit carries the root string twice: once as the path prefix and once
    // as a real directory tail ('backup/srv/api' — a directory named srv
    // holding a file named api). Eating the tail is the corruption the
    // leading boundary exists to prevent.
    const text =
      'Found 1 file(s) matching "**/*" within /srv/api\n---\n/srv/api/backup/srv/api';
    expect(relativizeGlobText(text, '/srv/api')).toBe(
      'Found 1 file(s) matching "**/*" within .\n---\nbackup/srv/api',
    );
  });

  it('does not fuse a nested directory whose name repeats the root tail', () => {
    // The R2-1 shape: '/app/src/app/component.ts' must become
    // 'src/app/component.ts', never 'srccomponent.ts'.
    const text = '/app/src/app/component.ts';
    expect(relativizeGlobText(text, '/app')).toBe('src/app/component.ts');
  });

  it('keeps the echoed pattern verbatim for a root of /', () => {
    // The degenerate root is both the boundary and every path's prefix: the
    // rewrite must stand down rather than eat the pattern's separators.
    const text =
      'Found 3 file(s) matching "etc*/host*" within /\n---\netc/hosts\netc/hostname';
    expect(relativizeGlobText(text, '/')).toBe(text);
  });
});

describe('ManagedToolExecutor acknowledgement', () => {
  const roots = new Set<string>();
  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.clear();
  });

  function workspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mtr-executor-'));
    roots.add(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'contents');
    return root;
  }

  const sessionReference = {
    sessionId: 'session-a',
    promptId: 'prompt-1',
    callId: 'call-1',
    argsDigest: createHash('sha256').update('args').digest('hex'),
  };

  it('lets a session close after its settled call is acknowledged', async () => {
    const executor = ManagedToolExecutor.forWorkspace(
      workspace(),
      'runtime-01',
    );
    const result = await executor.execute(sessionReference, 'read_file', {
      file_path: 'a.txt',
    });
    expect(result.executionStatus).toBe('success');

    expect(executor.acknowledge(sessionReference)?.state).toBe('acknowledged');
    // The acknowledged entry no longer holds the session's work open.
    expect(executor.hasActiveSession('session-a')).toBe(false);
    expect(() => executor.closeSessionAdmission('session-a')).not.toThrow();
  });

  it('reports a drained worker quiescent once its settled call is acknowledged', async () => {
    const executor = ManagedToolExecutor.forWorkspace(
      workspace(),
      'runtime-01',
    );
    const result = await executor.execute(sessionReference, 'read_file', {
      file_path: 'a.txt',
    });
    expect(result.executionStatus).toBe('success');
    executor.sealAdmission(retirementId);

    expect(executor.acknowledge(sessionReference)?.state).toBe('acknowledged');
    expect(executor.getDrainObservation(retirementId)).toEqual({
      state: 'DRAINING',
      workState: 'QUIESCENT',
      pendingStarts: 0,
      pendingInvocations: 0,
      blockers: [],
    });
  });

  it('answers unknown for a reference the Runtime never saw', () => {
    const executor = ManagedToolExecutor.forWorkspace(
      workspace(),
      'runtime-01',
    );
    expect(executor.acknowledge(sessionReference)).toBeNull();
    expect(executor.status(sessionReference)).toBeNull();
  });
});
