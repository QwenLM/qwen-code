/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import {
  getWorkflowTaskMutationKey,
  isTerminalWorkflowStatus,
  tryWithWorkflowTaskMutation,
  WorkflowRunRegistry,
  type WorkflowTask,
} from '../workflow-run-registry.js';
import { AgentEventEmitter } from './agent-events.js';
import {
  deriveAgentKey,
  deriveArgsSeed,
  WorkflowJournal,
  type JournalReplay,
} from './workflow-journal.js';
import {
  WorkflowRunner,
  WorkflowScriptNotLaunchedError,
  WorkflowStartCancelledError,
} from './workflow-runner.js';
import { compileWorkflowScript } from './workflow-sandbox.js';

const {
  createProductionDispatchMock,
  journalWrites,
  logWorkflowRunMock,
  persistInlineWorkflowScriptMock,
  resolveSavedWorkflowScriptMock,
  writeLineMock,
  writeWorkflowSnapshotMock,
} = vi.hoisted(() => ({
  createProductionDispatchMock: vi.fn(),
  journalWrites: [] as Array<() => void>,
  logWorkflowRunMock: vi.fn(),
  persistInlineWorkflowScriptMock: vi.fn(),
  resolveSavedWorkflowScriptMock: vi.fn(),
  writeLineMock: vi.fn(),
  writeWorkflowSnapshotMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../telemetry/loggers.js', () => ({
  logWorkflowRun: logWorkflowRunMock,
}));

vi.mock('../workflow-snapshot.js', () => ({
  writeWorkflowSnapshot: writeWorkflowSnapshotMock,
}));

vi.mock('../../utils/jsonl-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/jsonl-utils.js')>();
  return { ...actual, writeLine: writeLineMock };
});

vi.mock('./workflow-orchestrator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./workflow-orchestrator.js')>();
  return {
    ...actual,
    createProductionDispatch: createProductionDispatchMock,
  };
});

vi.mock('./workflow-saved.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workflow-saved.js')>();
  persistInlineWorkflowScriptMock.mockImplementation(
    actual.persistInlineWorkflowScript,
  );
  return {
    ...actual,
    persistInlineWorkflowScript: persistInlineWorkflowScriptMock,
    resolveSavedWorkflowScript: resolveSavedWorkflowScriptMock,
  };
});

function configWithRegistry(): {
  config: Config;
  registry: WorkflowRunRegistry;
} {
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
  } as unknown as Config;
  return { config, registry };
}

const storageRoots: string[] = [];

/** A fresh runtime dir for one test; removed after it. */
async function makeStorageRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-workflow-runner-'),
  );
  storageRoots.push(root);
  return root;
}

/**
 * Storage stub over a real temp dir. The persisted-script path is a real
 * location on purpose: this is the surface that writes a file, and a mocked
 * `fs` would prove nothing about where the bytes land or what mode they get.
 */
function stubStorage(config: Config, root: string): void {
  Object.assign(config, {
    storage: {
      getWorkflowRunJournalPath: (runId: string) =>
        path.join(root, runId, 'journal.jsonl'),
      getWorkflowRunsDir: () => root,
      getGeneratedWorkflowsDir: () => path.join(root, 'generated'),
      getInlineWorkflowScriptPath: (runId: string) =>
        path.join(root, 'generated', 'inline', `${runId}.js`),
    },
  });
}

function observeSettlement(registry: WorkflowRunRegistry): {
  abortCount: () => number;
  terminalStatuses: string[];
} {
  let aborts = 0;
  const terminalStatuses: string[] = [];
  registry.setRegisterCallback((entry) => {
    entry.abortController.signal.addEventListener(
      'abort',
      () => {
        aborts += 1;
      },
      { once: true },
    );
  });
  registry.setStatusChangeCallback((entry) => {
    if (entry && isTerminalWorkflowStatus(entry.status)) {
      terminalStatuses.push(entry.status);
    }
  });
  return { abortCount: () => aborts, terminalStatuses };
}

describe('WorkflowRunner', () => {
  beforeEach(() => {
    createProductionDispatchMock.mockReset();
    journalWrites.length = 0;
    logWorkflowRunMock.mockClear();
    persistInlineWorkflowScriptMock.mockClear();
    resolveSavedWorkflowScriptMock.mockReset();
    writeLineMock.mockReset();
    writeLineMock.mockResolvedValue(undefined);
    writeWorkflowSnapshotMock.mockClear();
    writeWorkflowSnapshotMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(
      storageRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it('passes the registry approval bridge only to production dispatch', async () => {
    const production = configWithRegistry();
    const productionBridge = vi.spyOn(
      production.registry,
      'bridgeApprovalEvents',
    );
    createProductionDispatchMock.mockReturnValue(async () => 'done');

    const productionHandle = await WorkflowRunner.start({
      config: production.config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
    });
    await expect(productionHandle.completion).resolves.toMatchObject({
      ok: true,
    });

    const bridgeApprovalEvents = createProductionDispatchMock.mock
      .calls[0]?.[3] as
      | ((emitter: AgentEventEmitter, dispatchId?: string) => () => void)
      | undefined;
    expect(bridgeApprovalEvents).toEqual(expect.any(Function));
    const emitter = new AgentEventEmitter();
    const cleanup = vi.fn();
    productionBridge.mockReturnValue(cleanup);
    expect(bridgeApprovalEvents?.(emitter, 'dispatch-1')).toBe(cleanup);
    expect(productionBridge).toHaveBeenCalledWith(
      productionHandle.runId,
      emitter,
      'dispatch-1',
      production.registry.get(productionHandle.runId),
    );

    const injected = configWithRegistry();
    const injectedBridge = vi.spyOn(injected.registry, 'bridgeApprovalEvents');
    const injectedHandle = await WorkflowRunner.start({
      config: injected.config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: async () => 'injected',
    });
    await expect(injectedHandle.completion).resolves.toMatchObject({
      ok: true,
    });
    expect(createProductionDispatchMock).toHaveBeenCalledOnce();
    expect(injectedBridge).not.toHaveBeenCalled();
  });

  it('retains the original args needed to retry a failed run from its journal', async () => {
    const { config, registry } = configWithRegistry();
    const args = { target: 'web-shell', checks: ['correctness'] };
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return args.target',
      args,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    await handle.completion;

    expect(registry.get(handle.runId)?.args).toEqual(args);
  });

  it('retains a saved workflow name when resuming with an inline script', async () => {
    const { config, registry } = configWithRegistry();
    resolveSavedWorkflowScriptMock.mockResolvedValueOnce({
      name: 'review',
      savedWorkflowName: 'review',
      scriptPath: '/tmp/review.js',
      script: 'return "done"',
    });
    const initial = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      scriptPath: '/tmp/review.js',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await initial.completion;

    const resumed = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "resumed"',
      args: undefined,
      resumeFromRunId: initial.runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await resumed.completion;

    expect(registry.get(initial.runId)?.workflowName).toBe('review');
  });

  it('records sandbox logs in the replay event ledger', async () => {
    const { config, registry } = configWithRegistry();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'log("repository loaded"); return "done";',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    await handle.completion;

    expect(registry.get(handle.runId)?.events).toEqual([
      expect.objectContaining({
        type: 'log',
        message: 'repository loaded',
      }),
      expect.objectContaining({ type: 'workflow-completed' }),
    ]);
  });

  it('keeps sandbox and registry phase projections equal for normalization-colliding titles', async () => {
    const { config, registry } = configWithRegistry();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script:
        'phase("\\u001b[1mBuild\\u001b[0m");' +
        'phase("Build");' +
        'await agent("x", { phase: "\\u001b[1mBuild\\u001b[0m" });' +
        'return 1;',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    const settlement = await handle.completion;

    expect(settlement.ok).toBe(true);
    const outcomePhases = settlement.ok ? settlement.outcome.phases : [];
    expect(registry.get(handle.runId)?.phases).toEqual(['Build']);
    expect(outcomePhases).toEqual(registry.get(handle.runId)?.phases);
  });

  it('records a journal retry as sourced from the same run', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    const attempt = await tryWithWorkflowTaskMutation(
      getWorkflowTaskMutationKey(config, runId),
      () =>
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return "retried"',
          args: undefined,
          resumeFromRunId: runId,
          runInBackground: true,
          dispatch: async () => 'unused',
        }),
    );
    expect(attempt.acquired).toBe(true);
    if (!attempt.acquired) return;
    const handle = attempt.value;

    await handle.completion;

    expect(registry.get(runId)).toMatchObject({
      runId,
      sourceRunId: runId,
      startMode: 'retry',
    });
  });

  it('replays a readable journal when its advertised path cannot be created', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    const runId = 'wf_1234abcd';
    const key = deriveAgentKey(deriveArgsSeed(undefined), 'work', {});
    vi.spyOn(WorkflowJournal.prototype, 'load').mockResolvedValueOnce({
      results: new Map([
        [key, { type: 'result', key, agentId: 'agent-1', result: 'cached' }],
      ]),
      started: new Map(),
    });
    vi.spyOn(WorkflowJournal.prototype, 'ensureExists').mockResolvedValueOnce(
      false,
    );
    const dispatch = vi.fn(async () => 'live');

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      resumeFromRunId: runId,
      dispatch,
    });

    await expect(handle.completion).resolves.toMatchObject({
      ok: true,
      outcome: { result: 'cached' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(handle.journalPath).toBeUndefined();
    expect(registry.get(runId)?.journalPath).toBeUndefined();
  });

  it('cancels a pending background resume before registration', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    const root = await makeStorageRoot();
    stubStorage(config, root);
    let resolveLoad: ((replay: JournalReplay) => void) | undefined;
    const loadSpy = vi
      .spyOn(WorkflowJournal.prototype, 'load')
      .mockImplementationOnce(
        () =>
          new Promise<JournalReplay>((resolve) => {
            resolveLoad = resolve;
          }),
      );
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "retried"',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    try {
      await vi.waitFor(() => expect(registry.isStarting(runId)).toBe(true));
      expect(registry.get(runId)).toBeUndefined();

      await vi.waitFor(() => expect(resolveLoad).toBeDefined());
      registry.abortAll();
      resolveLoad!({ results: new Map(), started: new Map() });

      await expect(start).rejects.toThrow('Workflow start was cancelled.');
      expect(registry.isStarting(runId)).toBe(false);
      expect(registry.get(runId)).toBeUndefined();
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    } finally {
      resolveLoad?.({ results: new Map(), started: new Map() });
      await start.catch(() => undefined);
      loadSpy.mockRestore();
    }
  });

  it('rejects a cancellation that lands while the inline script is persisted', async () => {
    const { config, registry } = configWithRegistry();
    const root = await makeStorageRoot();
    stubStorage(config, root);
    let releasePersist: (() => void) | undefined;
    persistInlineWorkflowScriptMock.mockImplementationOnce(
      async (_config: Config, runId: string, script: string) => {
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
        const file = path.join(root, 'generated', 'inline', `${runId}.js`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, script, 'utf8');
        return file;
      },
    );
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "done"',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });

    await vi.waitFor(() =>
      expect(registry.listStartingRunIds()).toHaveLength(1),
    );
    const runId = registry.listStartingRunIds()[0]!;
    await vi.waitFor(() => expect(releasePersist).toBeDefined());
    expect(registry.cancelStarting(runId)).toBe(true);
    releasePersist!();

    await expect(start).rejects.toBeInstanceOf(WorkflowStartCancelledError);
    expect(registry.get(runId)).toBeUndefined();
    await expect(
      fs.access(path.join(root, 'generated', 'inline', `${runId}.js`)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(root, runId, 'journal.jsonl')),
    ).rejects.toThrow();
  });

  it('restores resume artifacts when cancellation lands before registration', async () => {
    const { config, registry } = configWithRegistry();
    const root = await makeStorageRoot();
    stubStorage(config, root);
    const initial = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "original"',
      args: undefined,
      dispatch: async () => 'unused',
    });
    await initial.completion;
    const journalPath = initial.journalPath!;
    const scriptPath = initial.scriptPath!;
    const journalBefore = await fs.readFile(journalPath, 'utf8');
    let releasePersist: (() => void) | undefined;
    persistInlineWorkflowScriptMock.mockImplementationOnce(
      async (_config: Config, runId: string, script: string) => {
        await new Promise<void>((resolve) => {
          releasePersist = resolve;
        });
        const file = path.join(root, 'generated', 'inline', `${runId}.js`);
        await fs.writeFile(file, script, 'utf8');
        return file;
      },
    );

    const resume = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return "never ran"',
      args: undefined,
      resumeFromRunId: initial.runId,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await vi.waitFor(() => expect(releasePersist).toBeDefined());
    expect(registry.cancelStarting(initial.runId)).toBe(true);
    releasePersist!();

    await expect(resume).rejects.toBeInstanceOf(WorkflowStartCancelledError);
    await expect(fs.readFile(scriptPath, 'utf8')).resolves.toBe(
      'return "original"',
    );
    await expect(fs.readFile(journalPath, 'utf8')).resolves.toBe(journalBefore);
  });

  it.each([
    [true, true, false, true],
    [true, false, false, false],
    [true, true, true, false],
    [false, true, false, false],
  ])(
    'records resumeInBackground for background=%s interactive=%s zed=%s',
    async (background, interactive, zed, expected) => {
      const { config, registry } = configWithRegistry();
      Object.assign(config, {
        isInteractive: () => interactive,
        getExperimentalZedIntegration: () => zed,
      });

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "done"',
        args: undefined,
        runInBackground: background,
        dispatch: async () => 'unused',
      });
      await handle.completion;

      expect(registry.get(handle.runId)?.resumeInBackground).toBe(expected);
    },
  );

  it('cancels a pending background script load before registration', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    let finishLoad:
      | ((saved: { name: string; script: string; scriptPath: string }) => void)
      | undefined;
    resolveSavedWorkflowScriptMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        }),
    );
    const start = WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      scriptPath: '/tmp/review.js',
      args: undefined,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    const saved = {
      name: 'review',
      script: 'return "done"',
      scriptPath: '/tmp/review.js',
    };

    try {
      await vi.waitFor(() =>
        expect(resolveSavedWorkflowScriptMock).toHaveBeenCalledOnce(),
      );
      expect(registry.hasRunningEntries()).toBe(true);
      expect(registry.list()).toEqual([]);

      registry.abortAll();
      finishLoad?.(saved);

      await expect(start).rejects.toThrow('Workflow start was cancelled.');
      // Typed, not a bare Error: the tool maps this to its "cancelled
      // before it could start" result even when the caller's own signal
      // is still live.
      await expect(start).rejects.toBeInstanceOf(WorkflowStartCancelledError);
      expect(registry.hasRunningEntries()).toBe(false);
      expect(registry.list()).toEqual([]);
    } finally {
      finishLoad?.(saved);
      await start.catch(() => undefined);
    }
  });

  it('rejects a direct resume while history mutation owns the run', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    let releaseClaim: (() => void) | undefined;
    let claimReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      claimReady = resolve;
    });
    const claim = tryWithWorkflowTaskMutation(
      getWorkflowTaskMutationKey(config, runId),
      async () => {
        claimReady?.();
        await new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
      },
    );
    await ready;
    const loadSpy = vi.spyOn(WorkflowJournal.prototype, 'load');

    try {
      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: 'return "retried"',
          args: undefined,
          resumeFromRunId: runId,
          runInBackground: true,
          dispatch: async () => 'unused',
        }),
      ).rejects.toThrow(`Workflow run ${runId} is already being modified.`);
      expect(loadSpy).not.toHaveBeenCalled();
      expect(registry.isStarting(runId)).toBe(false);
      expect(registry.get(runId)).toBeUndefined();
    } finally {
      releaseClaim?.();
      await claim;
      loadSpy.mockRestore();
    }
  });

  it('keeps one registry-owned handle through exactly-once completion', async () => {
    const { config, registry } = configWithRegistry();
    const observed = observeSettlement(registry);
    let resolveDispatch: ((value: string) => void) | undefined;
    const caller = new AbortController();
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });

    expect(registry.getHandle(handle.runId)).toBe(handle);
    expect(registry.get(handle.runId)?.status).toBe('running');

    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    resolveDispatch?.('done');

    const first = await handle.completion;
    const second = await handle.completion;
    expect(first).toBe(second);
    expect(first.ok).toBe(true);
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(registry.getHandle(handle.runId)).toBeUndefined();
    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(logWorkflowRunMock).toHaveBeenCalledOnce();
    expect(observed.terminalStatuses).toEqual(['completed']);
    expect(observed.abortCount()).toBe(1);

    caller.abort();
    registry.cancel(handle.runId, Date.now());
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(logWorkflowRunMock).toHaveBeenCalledOnce();
    expect(observed.terminalStatuses).toEqual(['completed']);
    expect(observed.abortCount()).toBe(1);
  });

  it('notifies the registry when the terminal snapshot is persisted', async () => {
    const { config, registry } = configWithRegistry();
    writeWorkflowSnapshotMock.mockResolvedValue(true);
    const notify = vi.spyOn(registry, 'notifySnapshotPersisted');
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: async () => 'done',
    });
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(handle.runId);
  });

  it('does not notify when the snapshot write fails', async () => {
    const { config, registry } = configWithRegistry();
    writeWorkflowSnapshotMock.mockResolvedValue(false);
    const notify = vi.spyOn(registry, 'notifySnapshotPersisted');
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: async () => 'done',
    });
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('settles failure and caller cancellation through the same owner', async () => {
    const failed = configWithRegistry();
    const failedObserved = observeSettlement(failed.registry);
    const failedHandle = await WorkflowRunner.start({
      config: failed.config,
      signal: new AbortController().signal,
      script: 'throw new Error("boom")',
      args: undefined,
      dispatch: async () => 'unused',
    });
    const failedResult = await failedHandle.completion;
    expect(failedResult.ok).toBe(false);
    expect(failed.registry.get(failedHandle.runId)?.status).toBe('failed');
    expect(failedObserved.terminalStatuses).toEqual(['failed']);
    expect(failedObserved.abortCount()).toBe(1);

    const cancelled = configWithRegistry();
    const cancelledObserved = observeSettlement(cancelled.registry);
    const caller = new AbortController();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const cancelledHandle = await WorkflowRunner.start({
      config: cancelled.config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
    caller.abort();
    rejectDispatch?.(new Error('aborted'));
    const cancelledResult = await cancelledHandle.completion;
    expect(cancelledResult.ok).toBe(false);
    expect(cancelled.registry.get(cancelledHandle.runId)?.status).toBe(
      'cancelled',
    );
    expect(cancelledObserved.terminalStatuses).toEqual(['cancelled']);
    expect(cancelledObserved.abortCount()).toBe(1);

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowRunMock).toHaveBeenCalledTimes(2);
  });

  it('records caller-aborted dispatches as cancelled', async () => {
    const { config, registry } = configWithRegistry();
    const caller = new AbortController();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    caller.abort();
    rejectDispatch?.(new Error('Request was aborted'));
    await handle.completion;

    expect(registry.get(handle.runId)?.dispatches).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
    expect(registry.get(handle.runId)?.dispatches[0]).not.toHaveProperty(
      'error',
    );
    expect(registry.get(handle.runId)?.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch-failed' }),
      ]),
    );
  });

  it('keeps background runs alive after the caller turn ends', async () => {
    const { config, registry } = configWithRegistry();
    const observed = observeSettlement(registry);
    const caller = new AbortController();
    let resolveDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());

    caller.abort();
    expect(observed.abortCount()).toBe(0);
    expect(registry.get(handle.runId)?.status).toBe('running');

    resolveDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(observed.terminalStatuses).toEqual(['completed']);
    expect(observed.abortCount()).toBe(1);
  });

  it('persists terminal runs without live fire-and-forget dispatches', async () => {
    const { config, registry } = configWithRegistry();
    let snapshotDispatchStatuses: string[] | undefined;
    writeWorkflowSnapshotMock.mockImplementation(
      (_config, snapshotEntry: WorkflowTask) => {
        snapshotDispatchStatuses = snapshotEntry.dispatches.map(
          (dispatch) => dispatch.status,
        );
        return Promise.resolve();
      },
    );
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'agent("fire and forget"); return "done"',
      args: undefined,
      runInBackground: true,
      dispatch: () => new Promise<string>(() => undefined),
    });

    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    expect(registry.get(handle.runId)).toMatchObject({ status: 'completed' });
    expect(snapshotDispatchStatuses).toEqual(['cancelled']);
    expect(registry.get(handle.runId)?.dispatches).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  it('freezes snapshot and telemetry before late dispatches drain', async () => {
    const { config, registry } = configWithRegistry();
    stubStorage(config, await makeStorageRoot());
    writeLineMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          journalWrites.push(resolve);
        }),
    );
    let snapshotAgentsCompleted: number | undefined;
    writeWorkflowSnapshotMock.mockImplementation((_config, entry) => {
      snapshotAgentsCompleted = entry.agentsCompleted;
      return Promise.resolve();
    });
    let finishDispatch: ((result: string) => void) | undefined;

    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'agent("fire and forget"); return "done"',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });

    await vi.waitFor(() => {
      expect(registry.get(handle.runId)?.status).toBe('completed');
      expect(journalWrites).toHaveLength(1);
    });
    finishDispatch?.('late result');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.agentsCompleted).toBe(1),
    );
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    journalWrites[0]?.();
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    const telemetry = logWorkflowRunMock.mock.calls[0]?.[1] as
      | { agents_completed: number }
      | undefined;
    expect(telemetry?.agents_completed).toBe(0);
    expect(snapshotAgentsCompleted).toBe(0);
    for (const resolve of journalWrites) resolve();
  });

  it('holds an in-flight agent result until a paused run resumes', async () => {
    const { config, registry } = configWithRegistry();
    let resolveDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());

    expect(registry.pause(handle.runId)).toBe(true);
    expect(registry.get(handle.runId)?.status).toBe('pausing');
    resolveDispatch?.('done');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    expect(registry.resume(handle.runId)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    expect(registry.get(handle.runId)?.status).toBe('completed');
  });

  it('holds an in-flight agent rejection until a paused run resumes', async () => {
    const { config, registry } = configWithRegistry();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    registry.pause(handle.runId);
    rejectDispatch?.(new Error('agent failed'));
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );
    let settled = false;
    void handle.completion.then(() => {
      settled = true;
    });
    // Flush all microtasks + a timer tick so the negative check
    // distinguishes the pause gate from a gate-less resolve
    // (which settles in a few microtasks without one).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    registry.resume(handle.runId);
    await expect(handle.completion).resolves.toMatchObject({ ok: false });
    expect(registry.get(handle.runId)?.status).toBe('failed');
  });

  it('keeps queued agents stopped while pausing and starts them after resume', async () => {
    const originalConcurrency =
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
    process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '1';
    try {
      const { config, registry } = configWithRegistry();
      const started: string[] = [];
      const finishes = new Map<string, (value: string) => void>();
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: `return await parallel([
          async () => {
            await agent("first");
            // Chain a follow-up dispatch off the first result: if the pause
            // gate ever delivered that result early, the chained agent is
            // issued during the pause and bumps the dispatched counter below.
            return await agent("first-follow-up");
          },
          () => agent("second"),
        ])`,
        args: undefined,
        runInBackground: true,
        dispatch: (prompt) =>
          new Promise<string>((resolve) => {
            started.push(prompt);
            finishes.set(prompt, resolve);
          }),
      });
      await vi.waitFor(() => expect(started).toEqual(['first']));

      expect(registry.pause(handle.runId)).toBe(true);
      finishes.get('first')?.('first done');
      await vi.waitFor(() =>
        expect(registry.get(handle.runId)?.status).toBe('paused'),
      );
      expect(started).toEqual(['first']);
      expect(registry.get(handle.runId)).toMatchObject({
        agentsDispatched: 2,
        agentsCompleted: 1,
      });
      let settled = false;
      void handle.completion.then(() => {
        settled = true;
      });
      // Flush all microtasks + a timer tick so the negative check
      // distinguishes the pause gate from a gate-less resolve
      // (which settles in a few microtasks without one).
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);

      expect(registry.resume(handle.runId)).toBe(true);
      await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
      finishes.get('second')?.('second done');
      await vi.waitFor(() =>
        expect(started).toEqual(['first', 'second', 'first-follow-up']),
      );
      finishes.get('first-follow-up')?.('follow-up done');
      await expect(handle.completion).resolves.toMatchObject({ ok: true });
    } finally {
      if (originalConcurrency === undefined) {
        delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      } else {
        process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = originalConcurrency;
      }
    }
  });

  it('cancels a paused run without starting queued agents or deadlocking', async () => {
    const originalConcurrency =
      process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
    process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = '1';
    try {
      const { config, registry } = configWithRegistry();
      const started: string[] = [];
      let finishFirst: ((value: string) => void) | undefined;
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: `return await parallel([
          () => agent("first"),
          () => agent("second"),
        ])`,
        args: undefined,
        runInBackground: true,
        dispatch: (prompt) =>
          new Promise<string>((resolve) => {
            started.push(prompt);
            if (prompt === 'first') finishFirst = resolve;
          }),
      });
      await vi.waitFor(() => expect(started).toEqual(['first']));
      registry.pause(handle.runId);
      finishFirst?.('first done');
      await vi.waitFor(() =>
        expect(registry.get(handle.runId)?.status).toBe('paused'),
      );

      registry.cancel(handle.runId, Date.now());

      await expect(handle.completion).resolves.toMatchObject({ ok: false });
      expect(registry.get(handle.runId)).toMatchObject({
        status: 'cancelled',
        agentsDispatched: 2,
        agentsCompleted: 2,
      });
      expect(started).toEqual(['first']);
    } finally {
      if (originalConcurrency === undefined) {
        delete process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'];
      } else {
        process.env['QWEN_CODE_MAX_WORKFLOW_CONCURRENCY'] = originalConcurrency;
      }
    }
  });

  it('settles a cancelled paused run as cancelled even if its awaited dispatch succeeded', async () => {
    // The success arm resolves held successful dispatches on abort, so a
    // cancelled run's script can still finish normally. The settlement
    // must report the cancellation, not a success that contradicts the
    // registry entry, telemetry, and snapshot.
    const { config, registry } = configWithRegistry();
    const observed = observeSettlement(registry);
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    registry.pause(handle.runId);
    finishDispatch?.('done');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );

    registry.cancel(handle.runId, Date.now());

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Workflow run cancelled.',
    });
    expect(registry.get(handle.runId)?.status).toBe('cancelled');
    // cancel() fires the terminal statusChange; setRecentLogs then
    // mirrors the final logs onto the already-cancelled entry and
    // re-emits it — both fires are 'cancelled', never a success state.
    expect(observed.terminalStatuses).toEqual(['cancelled', 'cancelled']);
  });

  it('settles a cancelled running run as cancelled when its script absorbs the abort', async () => {
    // The cancelled-settlement guard must cover cancel-from-running too,
    // not only cancel-from-paused: a never-paused run whose script
    // absorbs the abort and still returns normally must not settle ok
    // while the registry entry, telemetry, and snapshot say cancelled.
    const { config, registry } = configWithRegistry();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script:
        'try { return await agent("work"); } catch { return "fallback"; }',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());
    expect(registry.get(handle.runId)?.status).toBe('running');

    registry.cancel(handle.runId, Date.now());
    rejectDispatch?.(new Error('aborted'));

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Workflow run cancelled.',
    });
    expect(registry.get(handle.runId)?.status).toBe('cancelled');
  });

  it('settles an externally failed run as failed even if its script still completes', async () => {
    // The settlement guard must cover every terminal status, not only
    // 'cancelled': resolvePendingApproval's contingency fails the entry
    // and aborts the handle, and the success arm still delivers held
    // successful dispatches on abort — so the script can finish
    // normally while the registry entry, snapshot, and telemetry say
    // 'failed'. The handle must not report ok: true.
    const { config, registry } = configWithRegistry();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    registry.fail(
      handle.runId,
      'Failed to resolve workflow approval: wfap_1',
      Date.now(),
    );
    handle.abort();
    finishDispatch?.('done');

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Failed to resolve workflow approval: wfap_1',
    });
    expect(registry.get(handle.runId)?.status).toBe('failed');
  });

  it('rejects a concurrent resume while the original run is active', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    let resolveDispatch: ((value: string) => void) | undefined;
    const original = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("original")',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveDispatch).toBeDefined());
    const replacementCaller = new AbortController();
    const replacementDispatch = vi.fn(async () => 'replacement');

    try {
      await expect(
        WorkflowRunner.start({
          config,
          signal: replacementCaller.signal,
          script: 'return await agent("replacement")',
          args: undefined,
          resumeFromRunId: runId,
          dispatch: replacementDispatch,
        }),
      ).rejects.toThrow(/already active/);
      expect(registry.getHandle(runId)).toBe(original);
      expect(replacementDispatch).not.toHaveBeenCalled();
      expect(getEventListeners(replacementCaller.signal, 'abort')).toHaveLength(
        0,
      );
    } finally {
      resolveDispatch?.('original');
      await original.completion;
    }

    expect(registry.get(runId)?.result).toBe('original');
  });

  it('ignores late dispatch callbacks from a prior retry entry', async () => {
    const { config, registry } = configWithRegistry();
    const runId = 'wf_1234abcd';
    let rejectOriginal: ((error: Error) => void) | undefined;
    const original = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'agent("original"); throw new Error("original failed")',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectOriginal = reject;
        }),
    });
    await expect(original.completion).resolves.toMatchObject({ ok: false });

    let resolveRetry: ((value: string) => void) | undefined;
    const retry = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("retry")',
      args: undefined,
      resumeFromRunId: runId,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          resolveRetry = resolve;
        }),
    });
    await vi.waitFor(() => expect(resolveRetry).toBeDefined());

    rejectOriginal?.(new Error('aborted by old controller'));
    resolveRetry?.('done');
    await expect(retry.completion).resolves.toMatchObject({ ok: true });

    expect(registry.get(runId)?.dispatches).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(registry.get(runId)?.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'dispatch-failed',
          error: 'aborted by old controller',
        }),
      ]),
    );
  });

  it('classifies a background failure after caller abort as failed', async () => {
    const { config, registry } = configWithRegistry();
    const caller = new AbortController();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: undefined,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    caller.abort();
    rejectDispatch?.(new Error('background boom'));

    await expect(handle.completion).resolves.toMatchObject({ ok: false });
    expect(registry.get(handle.runId)?.status).toBe('failed');
  });

  it('routes registry cancellation through each live handle', async () => {
    const cancelCases: Array<{
      cancel: (registry: WorkflowRunRegistry, runId: string) => void;
    }> = [
      {
        cancel: (registry, runId) => registry.cancel(runId, Date.now()),
      },
      {
        cancel: (registry) => registry.abortAll(),
      },
    ];

    for (const { cancel } of cancelCases) {
      const { config, registry } = configWithRegistry();
      const observed = observeSettlement(registry);
      let rejectDispatch: ((error: Error) => void) | undefined;
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return await agent("work")',
        args: undefined,
        runInBackground: true,
        dispatch: () =>
          new Promise<string>((_resolve, reject) => {
            rejectDispatch = reject;
          }),
      });
      const abortSpy = vi.spyOn(handle, 'abort');
      await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

      cancel(registry, handle.runId);

      expect(abortSpy).toHaveBeenCalledOnce();
      expect(observed.abortCount()).toBe(1);
      expect(registry.get(handle.runId)?.status).toBe('cancelled');
      expect(registry.getHandle(handle.runId)).toBe(handle);

      rejectDispatch?.(new Error('aborted'));
      const result = await handle.completion;
      expect(result.ok).toBe(false);
      expect(registry.get(handle.runId)?.status).toBe('cancelled');
      expect(registry.getHandle(handle.runId)).toBeUndefined();
    }

    expect(writeWorkflowSnapshotMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowRunMock).toHaveBeenCalledTimes(2);
  });

  it('classifies the internal wall-clock timeout as failed', async () => {
    vi.useFakeTimers();
    const originalTimeout = process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = '1';
    try {
      const timedOut = configWithRegistry();
      const observed = observeSettlement(timedOut.registry);
      const handle = await WorkflowRunner.start({
        config: timedOut.config,
        signal: new AbortController().signal,
        script: 'await new Promise(() => {})',
        args: undefined,
        runInBackground: true,
        dispatch: async () => 'unused',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await handle.completion;
      expect(result.ok).toBe(false);
      expect(timedOut.registry.get(handle.runId)?.status).toBe('failed');
      expect(observed.terminalStatuses).toEqual(['failed']);
      expect(observed.abortCount()).toBe(1);
      expect(writeWorkflowSnapshotMock).toHaveBeenCalledOnce();
      expect(logWorkflowRunMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      if (originalTimeout === undefined) {
        delete process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
      } else {
        process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = originalTimeout;
      }
    }
  });

  // ── Pre-launch compile gate ──────────────────────────────────────────
  //
  // `start()` used to mint a runId, open a journal and register the run
  // before a byte was parsed, so one TypeScript annotation produced a
  // registered, failed run: a phantom row in `/workflows`, a snapshot on
  // disk, and a telemetry event, for a workflow that never began.
  describe('pre-launch compile gate', () => {
    const TS_ANNOTATION = "const target: string = 'x';\nawait agent(target);";

    it('refuses a script that cannot compile', async () => {
      const { config } = configWithRegistry();
      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: TS_ANNOTATION,
          args: undefined,
        }),
      ).rejects.toThrow(/was not launched/);
    });

    // The point of the gate is not the message, it is that nothing survives
    // the refusal. Each of these is a side effect the old ordering produced
    // for a script that never ran.
    it('leaves no run, no snapshot, no journal and no telemetry behind', async () => {
      const { config, registry } = configWithRegistry();
      logWorkflowRunMock.mockClear();
      writeWorkflowSnapshotMock.mockClear();
      writeLineMock.mockClear();

      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: TS_ANNOTATION,
          args: undefined,
        }),
      ).rejects.toThrow();

      expect(registry.list()).toHaveLength(0);
      expect(writeWorkflowSnapshotMock).not.toHaveBeenCalled();
      expect(logWorkflowRunMock).not.toHaveBeenCalled();
      expect(writeLineMock).not.toHaveBeenCalled();
    });

    it('names the offending line and explains the usual cause', async () => {
      const { config } = configWithRegistry();
      const error = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: `await agent('one');\n${TS_ANNOTATION}`,
        args: undefined,
      }).then(
        () => {
          throw new Error('expected the script to be refused');
        },
        (e: unknown) => e as Error,
      );

      // Line 2 of the script, not line 3 of the wrapped source the vm sees.
      expect(error.message).toContain('line 2');
      expect(error.message).toContain('^');
      expect(error.message).toContain('plain JavaScript');
      expect(error.message).toContain('TypeScript syntax');
    });

    it.each([
      ['CRLF', '\r\n'],
      ['U+2028', '\u2028'],
      ['lone CR', '\r'],
    ])(
      'attributes the author line with %s separators',
      async (_name, separator) => {
        const { config } = configWithRegistry();
        const error = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: `await agent('one');${separator}const x: string = 1;`,
          args: undefined,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(WorkflowScriptNotLaunchedError);
        expect((error as Error).message).toContain('line 2');
        expect((error as Error).message).toContain('const x: string = 1;');
      },
    );

    // A malformed `export const meta` cannot start a run either, and it
    // reaches the same refusal rather than becoming a registered failure.
    it.each([
      [
        'export const meta = { name: someIdentifier }\nawait x();',
        'extractAndStripMeta',
      ],
      ["export const meta = { name: 'x'", 'stripExportMeta'],
    ])(
      'refuses a malformed meta literal without leaking internal names',
      async (script, internalName) => {
        const { config, registry } = configWithRegistry();
        const error = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script,
          args: undefined,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WorkflowScriptNotLaunchedError);
        expect((error as Error).message).toMatch(
          /invalid meta object literal|unbalanced braces/,
        );
        expect((error as Error).message).not.toContain(internalName);
        expect((error as Error).message).not.toContain('has a syntax error');
        expect(registry.list()).toHaveLength(0);
      },
    );

    // The equivalence that makes the gate trustworthy: the gate and the run
    // compile through one exported function, so a script cannot pass the gate
    // and then fail to compile inside the run. Drive both sides from one
    // fixture list — if they ever diverge, one of these rows flips.
    it('accepts exactly what the shared compile step accepts', async () => {
      const fixtures = [
        "await agent('plain');",
        "export const meta = { name: 'n', description: 'd' }\nawait agent('x');",
        '',
        "const s = 'a: string = 1';\nawait agent(s);", // looks like TS, is a string
        TS_ANNOTATION,
        'await agent(',
        'export const meta = { name: someIdentifier }',
      ];

      for (const source of fixtures) {
        let compileThrew = false;
        try {
          compileWorkflowScript(source);
        } catch {
          compileThrew = true;
        }

        const { config } = configWithRegistry();
        const started = await WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: source,
          args: undefined,
          dispatch: async () => 'ok',
        }).then(
          (handle) => {
            void handle.completion.catch(() => undefined);
            return true;
          },
          () => false,
        );

        expect(
          started,
          `fixture disagreed between gate and compile: ${JSON.stringify(source)}`,
        ).toBe(!compileThrew);
      }
    });
  });
  // ── Persisted inline script ─────────────────────────────────────────
  //
  // An inline script used to exist only in memory and in the terminal
  // snapshot: a model that wanted to resume had to re-send the whole source,
  // and a user had no file to read. The runner now writes it under the
  // generated root — the same root `{scriptPath}` already trusts — so the
  // path it hands back is one the loader will take back.
  describe('persisted inline script', () => {
    it('writes the inline script under the generated root and hands back both paths', async () => {
      const { config, registry } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      const script = 'return "done"';

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script,
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      const expected = path.join(
        root,
        'generated',
        'inline',
        `${handle.runId}.js`,
      );
      expect(handle.scriptPath).toBe(expected);
      expect(handle.journalPath).toBe(
        path.join(root, handle.runId, 'journal.jsonl'),
      );
      await expect(fs.readFile(expected, 'utf8')).resolves.toBe(script);
      if (process.platform !== 'win32') {
        const stat = await fs.stat(expected);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      // The registry entry carries both too: the terminal notification is
      // built from the entry, long after the handle is out of scope.
      const entry = registry.get(handle.runId);
      expect(entry?.scriptPath).toBe(expected);
      expect(entry?.journalPath).toBe(handle.journalPath);
    });

    it('writes nothing for a scriptPath launch and reports the loaded path', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      resolveSavedWorkflowScriptMock.mockResolvedValueOnce({
        name: 'review',
        savedWorkflowName: 'review',
        scriptPath: '/tmp/review.js',
        script: 'return "loaded"',
      });

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        scriptPath: '/tmp/review.js',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      expect(handle.scriptPath).toBe('/tmp/review.js');
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    });

    it('does not replace an existing script path with a generated copy', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "loaded"',
        scriptPath: '/tmp/review.js',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      expect(handle.scriptPath).toBe('/tmp/review.js');
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    });

    it('leaves no file behind when the script does not compile', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);

      await expect(
        WorkflowRunner.start({
          config,
          signal: new AbortController().signal,
          script: "const target: string = 'x';\nawait agent(target);",
          args: undefined,
        }),
      ).rejects.toThrow(/was not launched/);

      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).rejects.toThrow();
    });

    // A symlinked generated root is refused by the loader, so writing through
    // it would persist a script nothing can read back — and it is the shape a
    // planted link would use to place model-authored source outside the
    // runtime dir. Degrade, never fail the run over it.
    it('refuses a symlinked generated root without failing the run', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, path.join(root, 'generated'), 'dir');

      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "done"',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(handle.completion).resolves.toMatchObject({ ok: true });

      expect(handle.scriptPath).toBeUndefined();
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    });

    // The resume contract the description states: edit that file, pass the
    // path back. The second run must land on the same file rather than
    // accumulating a copy per attempt.
    it('overwrites the same file when an inline run is resumed', async () => {
      const { config } = configWithRegistry();
      const root = await makeStorageRoot();
      stubStorage(config, root);

      const first = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "first"',
        args: undefined,
        dispatch: async () => 'unused',
      });
      await expect(first.completion).resolves.toMatchObject({ ok: true });

      const second = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return "second"',
        args: undefined,
        resumeFromRunId: first.runId,
        dispatch: async () => 'unused',
      });
      await expect(second.completion).resolves.toMatchObject({ ok: true });

      expect(second.scriptPath).toBe(first.scriptPath);
      await expect(fs.readFile(first.scriptPath!, 'utf8')).resolves.toBe(
        'return "second"',
      );
      await expect(
        fs.readdir(path.join(root, 'generated', 'inline')),
      ).resolves.toEqual([`${first.runId}.js`]);
    });
  });
});
