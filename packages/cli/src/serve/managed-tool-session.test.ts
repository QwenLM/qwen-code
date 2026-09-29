/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileHistoryService,
  ToolConfirmationOutcome,
  type Config,
  type ManagedToolFileHistoryBinding,
  type ManagedToolFileHistoryState,
  type ManagedToolV2Client,
  type ManagedToolInvocationReference,
} from '@qwen-code/qwen-code-core';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import { createManagedToolSessionFactory } from './managed-tool-session.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('managed tool Session binding', () => {
  let cwd: string;
  let guard: ReturnType<typeof createWorkspaceGenerationGuard>;
  const clients = new Map<string, ManagedToolV2Client>();
  const states = new Map<string, ManagedToolFileHistoryState>();
  const bindings = new Map<string, ManagedToolFileHistoryBinding>();
  const getClient =
    vi.fn<NonNullable<ManagedRuntimeProvider['getToolV2Client']>>();
  const inspectExecution =
    vi.fn<NonNullable<ManagedRuntimeProvider['inspectExecution']>>();
  const cancelExecution =
    vi.fn<NonNullable<ManagedRuntimeProvider['cancelExecution']>>();
  const release = vi.fn<ManagedRuntimeProvider['release']>();
  const provider = {
    getToolV2Client: getClient,
    inspectExecution,
    cancelExecution,
    release,
  } as unknown as ManagedRuntimeProvider;

  function clientFor(sessionId: string): ManagedToolV2Client {
    let state: ManagedToolFileHistoryState;
    const client = {
      manifest: vi.fn().mockResolvedValue({
        tools: [],
        capabilityDigest: 'digest',
        policyRevision: 'policy',
      }),
      beginTurn: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue({}),
      confirmation: vi.fn().mockResolvedValue({}),
      confirm: vi.fn().mockResolvedValue(undefined),
      preflight: vi.fn().mockResolvedValue({ shouldProceed: true }),
      prepareExecution: vi.fn().mockResolvedValue({
        executionCallId: 'execution-1',
        invocationBindingId: sessionId,
      }),
      startExecution: vi.fn().mockResolvedValue({
        executionStatus: 'success',
        result: { llmContent: 'ok', returnDisplay: 'ok' },
      }),
      execute: vi.fn().mockResolvedValue({
        executionStatus: 'success',
        result: { llmContent: 'ok', returnDisplay: 'ok' },
      }),
      status: vi.fn().mockResolvedValue({ state: 'settled' }),
      cancel: vi.fn().mockResolvedValue({ state: 'settled' }),
      fileHistory: {
        bind: vi.fn(async (binding: ManagedToolFileHistoryBinding) => {
          bindings.set(sessionId, binding);
          state = states.get(binding.ownerRuntimeSessionId) ?? {
            ownerSessionId: binding.ownerSessionId,
            revision: 0,
            snapshots: structuredClone(binding.snapshots),
          };
          states.set(sessionId, state);
          return structuredClone(state);
        }),
        checkpoint: vi.fn(async (promptId: string) => {
          state.snapshots.push({
            promptId,
            timestamp: new Date().toISOString(),
            trackedFileBackups: {},
          });
          state.revision++;
          return structuredClone(state);
        }),
        snapshot: vi.fn(async () => structuredClone(state)),
      },
    } as unknown as ManagedToolV2Client;
    clients.set(sessionId, client);
    return client;
  }
  beforeEach(async () => {
    cwd = await realpath(
      await mkdtemp(join(tmpdir(), 'managed-tool-session-')),
    );
    vi.stubEnv('QWEN_HOME', cwd);
    guard = createWorkspaceGenerationGuard();
    clients.clear();
    states.clear();
    bindings.clear();
    getClient
      .mockReset()
      .mockImplementation(async ({ sessionId }) => clientFor(sessionId));
    inspectExecution.mockReset();
    release.mockReset().mockResolvedValue(true);
  });
  afterEach(async () => {
    guard.close();
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });
  function create(trusted = true) {
    const id = randomUUID();
    const service = new FileHistoryService(id, true, cwd);
    const record = vi.fn().mockResolvedValue(undefined);
    const config = {
      getTargetDir: () => cwd,
      getWorkspaceContext: () => ({ getDirectories: () => [cwd] }),
      getMemoryBaseDir: () => join(cwd, 'memory-base'),
      getFileFilteringOptions: () => ({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      isLsToolEnabled: () => false,
      getUseRipgrep: () => true,
      getUseBuiltinRipgrep: () => true,
      getTruncateToolOutputThreshold: () => 25000,
      getTruncateToolOutputLines: () => 1000,
      isTruncateToolOutputThresholdExplicit: () => false,
      getSessionId: () => id,
      getFileHistoryService: () => service,
      getChatRecordingService: () => ({
        recordFileHistorySnapshotBatchStrict: record,
      }),
    } as unknown as Config;
    const session = createManagedToolSessionFactory({
      provider,
      tenantId: 'tenant',
      workspaceId: 'workspace',
      workspaceCwd: cwd,
      workspaceTrusted: trusted,
      generationGuard: guard,
      shellConfiguration: {
        shell: 'bash',
        executable: 'bash',
        argsPrefix: ['-c'],
      },
      platform: 'darwin',
    })(config);
    return { session, config, service, record };
  }

  it('records an empty no-tool parent turn without acquiring a worker', async () => {
    const { session, record } = create();
    await session.beginFileHistoryTurn!('parent-turn');
    expect(record).toHaveBeenCalledWith([
      expect.objectContaining({ promptId: 'parent-turn' }),
    ]);
    await session.close();
    expect(getClient).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(() => session.getClient()).toThrow('closing');
  });

  it('captures each actual scope and refuses active RPCs after its context changes while cleanup remains available', async () => {
    const { session, config } = create();
    const remote = await session.getClient();
    expect(getClient).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.sessionId }),
      { harnessSessionId: config.getSessionId() },
    );
    const binding = bindings.get(session.sessionId)!;
    expect(binding.executionContext).toEqual({
      workspaceDirectories: [cwd],
      memoryBaseDir: join(cwd, 'memory-base'),
      lsToolEnabled: false,
      grepOptions: { useRipgrep: true, useBuiltinRipgrep: true },
      outputLimits: { chars: 25000, lines: 1000, charsExplicit: false },
      fileFilteringOptions: {
        respectGitIgnore: true,
        respectQwenIgnore: true,
        customIgnoreFiles: ['.agentignore', '.aiignore'],
      },
    });
    await remote.manifest();
    const rawClient = clients.get(session.sessionId)!;
    expect(rawClient.manifest).toHaveBeenCalledOnce();
    const ref: ManagedToolInvocationReference = {
      sessionId: session.sessionId,
      promptId: 'prompt',
      callId: 'call',
      invocationId: 'invocation',
      capabilityDigest: 'capability',
      policyRevision: 'policy',
      argsDigest: 'args',
    };
    await remote.confirm(
      ref,
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      'permission',
    );
    expect(rawClient.confirm).toHaveBeenCalledWith(
      ref,
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      'permission',
    );
    config.getFileFilteringOptions = () => ({
      respectGitIgnore: false,
      respectQwenIgnore: true,
    });
    for (const operation of [
      () => remote.manifest(),
      () => remote.beginTurn(ref),
      () => remote.prepare(ref, 'glob', { pattern: '*.txt' }),
      () => remote.confirmation(ref),
      () => remote.confirm(ref, ToolConfirmationOutcome.ProceedOnce),
      () => remote.preflight(ref),
      () => remote.execute(ref),
    ])
      await expect(operation()).rejects.toThrow('execution context changed');
    expect(rawClient.execute).not.toHaveBeenCalled();
    expect(rawClient.prepare).not.toHaveBeenCalled();
    await remote.status(ref);
    await remote.cancel(ref);
    await session.flushFileHistory!();
    await session.close();
    expect(rawClient.status).toHaveBeenCalledWith(ref, undefined);
    expect(rawClient.cancel).toHaveBeenCalledWith(ref);
    expect(release).toHaveBeenCalledOnce();
  });

  it('coalesces acquisition and keeps independently owned execution identities', async () => {
    const firstCreated = create();
    const secondCreated = create();
    const first = firstCreated.session;
    const second = secondCreated.session;
    expect(first.sessionId).not.toBe(second.sessionId);
    const [a, b] = await Promise.all([first.getClient(), first.getClient()]);
    expect(a).toBe(b);
    await second.getClient();
    expect(getClient).toHaveBeenCalledTimes(2);
    expect(getClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: 'tenant',
        workspaceId: 'workspace',
        workspaceCwd: cwd,
        sessionId: first.sessionId,
      }),
      { harnessSessionId: firstCreated.config.getSessionId() },
    );
    await first.close();
    expect(release).toHaveBeenCalledWith(
      first.sessionId,
      getClient.mock.calls[0][0],
      { terminal: true },
    );
    await second.close();
  });

  it('preserves two-phase execution through the Session wrapper', async () => {
    const { session } = create();
    const remote = await session.getClient();
    const raw = clients.get(session.sessionId)!;
    const ref: ManagedToolInvocationReference = {
      sessionId: session.sessionId,
      promptId: 'prompt',
      callId: 'call',
      invocationId: 'invocation',
      capabilityDigest: 'capability',
      policyRevision: 'policy',
      argsDigest: 'args',
    };

    const reservation = await remote.prepareExecution!(ref);
    expect(reservation).toEqual({
      executionCallId: 'execution-1',
      invocationBindingId: session.sessionId,
    });
    expect(raw.startExecution).not.toHaveBeenCalled();

    await remote.startExecution!(ref, reservation.executionCallId);
    expect(raw.prepareExecution).toHaveBeenCalledExactlyOnceWith(ref);
    expect(raw.startExecution).toHaveBeenCalledExactlyOnceWith(
      ref,
      reservation.executionCallId,
    );
    await session.close();
  });

  it('inspects a durable execution from the root Session without acquiring a Runtime', async () => {
    const { session, config } = create();
    inspectExecution.mockResolvedValue({
      outcome: 'known',
      status: {
        state: 'prepared',
        cancelRequested: false,
        lastSeq: 0,
        firstAvailableSeq: 0,
        progressGap: false,
        progress: [],
      },
    });

    await expect(
      session.inspectExecution!({
        runtimeSessionId: 'runtime-session',
        executionCallId: 'execution-call',
        afterSeq: 7,
      }),
    ).resolves.toMatchObject({
      outcome: 'known',
      status: { state: 'prepared' },
    });
    expect(inspectExecution).toHaveBeenCalledExactlyOnceWith({
      harnessSessionId: config.getSessionId(),
      runtimeSessionId: 'runtime-session',
      executionCallId: 'execution-call',
      afterSeq: 7,
    });
    expect(getClient).not.toHaveBeenCalled();

    cancelExecution.mockResolvedValue({
      outcome: 'known',
      status: {
        state: 'settled',
        cancelRequested: true,
        lastSeq: 1,
        firstAvailableSeq: 1,
        progressGap: false,
        progress: [],
        result: { executionStatus: 'cancelled' },
      },
    });
    await session.cancelExecution!({
      runtimeSessionId: 'runtime-session',
      executionCallId: 'execution-call',
      afterSeq: 7,
    });
    expect(cancelExecution).toHaveBeenCalledExactlyOnceWith({
      harnessSessionId: config.getSessionId(),
      runtimeSessionId: 'runtime-session',
      executionCallId: 'execution-call',
      afterSeq: 7,
    });
    expect(getClient).not.toHaveBeenCalled();

    const child = session.createChild!(config);
    expect(child.inspectExecution).toBeUndefined();
    expect(child.cancelExecution).toBeUndefined();
    await child.close();
    await session.close();
  });

  it('binds parent history before the first child tool and persists later child changes in the parent writer', async () => {
    const { session, config, service, record } = create();
    await session.beginFileHistoryTurn!('parent-1');
    const child = session.createChild!(config);
    expect(getClient).not.toHaveBeenCalled();
    await child.getClient();
    expect(getClient.mock.calls.map(([request]) => request.sessionId)).toEqual([
      session.sessionId,
      child.sessionId,
    ]);
    expect(
      bindings
        .get(session.sessionId)
        ?.snapshots.map((snapshot) => snapshot.promptId),
    ).toEqual(['parent-1']);
    expect(bindings.get(child.sessionId)).toMatchObject({
      ownerRuntimeSessionId: session.sessionId,
      ownerSessionId: config.getSessionId(),
      snapshots: [],
    });
    await child.beginFileHistoryTurn!('child-1');
    await session.beginFileHistoryTurn!('parent-2');
    await session.getClient();
    const state = states.get(session.sessionId)!;
    state.snapshots[1].trackedFileBackups['created.txt'] = {
      backupFileName: null,
      version: 1,
      backupTime: new Date().toISOString(),
    };
    state.revision++;
    await child.flushFileHistory!();
    expect(service.getSnapshots().map((snapshot) => snapshot.promptId)).toEqual(
      ['parent-1', 'parent-2'],
    );
    expect(record).toHaveBeenLastCalledWith([
      expect.objectContaining({
        promptId: 'parent-2',
        trackedFileBackups: expect.objectContaining({
          'created.txt': expect.anything(),
        }),
      }),
    ]);
    await child.close();
    await session.close();
  });

  it('captures a same-directory child scope independently of its parent', async () => {
    const { session, config } = create();
    const childConfig = {
      ...config,
      getWorkspaceContext: () => ({ getDirectories: () => [] }),
      getFileFilteringOptions: () => ({
        respectGitIgnore: false,
        respectQwenIgnore: true,
        customIgnoreFiles: [],
      }),
      getMemoryBaseDir: () => join(cwd, 'child-memory'),
      isLsToolEnabled: () => true,
    } as unknown as Config;
    const child = session.createChild!(childConfig);
    await child.getClient();
    expect(
      bindings.get(session.sessionId)?.executionContext?.workspaceDirectories,
    ).toEqual([cwd]);
    expect(bindings.get(child.sessionId)?.executionContext).toEqual({
      workspaceDirectories: [],
      memoryBaseDir: join(cwd, 'child-memory'),
      lsToolEnabled: true,
      grepOptions: { useRipgrep: true, useBuiltinRipgrep: true },
      outputLimits: { chars: 25000, lines: 1000, charsExplicit: false },
      fileFilteringOptions: {
        respectGitIgnore: false,
        respectQwenIgnore: true,
        customIgnoreFiles: [],
      },
    });
    await child.close();
    await session.close();
  });

  it('retries history persistence after the Gateway writer rejects an update', async () => {
    const { session, record } = create();
    await session.getClient();
    const state = states.get(session.sessionId)!;
    state.snapshots.push({
      promptId: 'persist-me',
      timestamp: new Date().toISOString(),
      trackedFileBackups: {},
    });
    state.revision++;
    record.mockImplementationOnce(() => {
      throw new Error('writer unavailable');
    });
    await expect(session.flushFileHistory!()).rejects.toThrow(
      'writer unavailable',
    );
    await session.flushFileHistory!();
    expect(record).toHaveBeenCalledTimes(2);
    await session.close();
  });

  it('drains an execution with a lost receipt before syncing its last history and releasing', async () => {
    const { session, service } = create();
    const wrapped = await session.getClient();
    const raw = clients.get(session.sessionId)!;
    const reference = {
      invocationId: 'lost-receipt',
    } as ManagedToolInvocationReference;
    vi.mocked(raw.execute).mockRejectedValueOnce(new Error('response lost'));
    await expect(wrapped.execute(reference)).rejects.toThrow('response lost');
    vi.mocked(raw.cancel).mockResolvedValueOnce({
      state: 'cancel_requested',
    } as Awaited<ReturnType<ManagedToolV2Client['cancel']>>);
    vi.mocked(raw.status).mockImplementationOnce(async () => {
      const state = states.get(session.sessionId)!;
      state.snapshots.push({
        promptId: 'late-edit',
        timestamp: new Date().toISOString(),
        trackedFileBackups: {},
      });
      state.revision++;
      return { state: 'settled' } as Awaited<
        ReturnType<ManagedToolV2Client['status']>
      >;
    });
    await session.close();
    expect(raw.cancel).toHaveBeenCalledWith(reference);
    expect(raw.status).toHaveBeenCalledWith(reference);
    expect(service.getSnapshots().at(-1)?.promptId).toBe('late-edit');
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains failed checkpoint ordering so later tools cannot bypass it', async () => {
    const { session } = create();
    await session.getClient();
    vi.mocked(
      clients.get(session.sessionId)!.fileHistory!.checkpoint,
    ).mockRejectedValueOnce(new Error('checkpoint unavailable'));
    await session.beginFileHistoryTurn!('parent-2');
    await expect(session.getClient()).rejects.toThrow('checkpoint unavailable');
    await session.close();
  });

  it('awaits late acquisition and real release, retaining a failed close for retry', async () => {
    const acquired = deferred<ManagedToolV2Client>();
    const released = deferred<boolean>();
    getClient.mockReturnValue(acquired.promise);
    release.mockReturnValueOnce(released.promise);
    const { session } = create();
    const pending = session.getClient().catch((error: unknown) => error);
    await vi.waitFor(() => expect(getClient).toHaveBeenCalledOnce());
    const close = session.close();
    expect(session.close()).toBe(close);
    const rejectedClose = close.catch((error: unknown) => error);
    expect(release).not.toHaveBeenCalled();
    acquired.resolve(clientFor(session.sessionId));
    expect(await pending).toMatchObject({
      message: 'Managed tool Session is closing.',
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    released.reject(new Error('not contained'));
    expect(await rejectedClose).toMatchObject({ message: 'not contained' });
    expect(() => session.getClient()).toThrow('closing');
    await session.close();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('releases a Session even when acquisition fails after dispatch', async () => {
    getClient.mockRejectedValue(new Error('reply lost'));
    const { session } = create();
    await expect(session.getClient()).rejects.toThrow('reply lost');
    await session.close();
    expect(release).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ sessionId: session.sessionId }),
      { terminal: true },
    );
  });

  it('rejects unsupported history control and still releases the acquired Session', async () => {
    getClient.mockResolvedValue({} as ManagedToolV2Client);
    const { session } = create();
    await expect(session.getClient()).rejects.toThrow('file history control');
    await session.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not claim cleanup from an unproven false response', async () => {
    release.mockResolvedValueOnce(false);
    const { session } = create();
    await session.getClient();
    await expect(session.close()).rejects.toThrow('unproven');
    await session.close();
  });

  it('checks admission before using even an already acquired client', async () => {
    const { session } = create();
    await session.getClient();
    guard.close();
    expect(() => session.getClient()).toThrow();
    await session.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an untrusted workspace before contacting the provider', async () => {
    const { session } = create(false);
    expect(() => session.getClient()).toThrow('workspace binding');
    await session.close();
    expect(getClient).not.toHaveBeenCalled();
  });
});
