/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { WorkflowRunRegistry } from '../workflow-run-registry.js';
import { WorkflowRunner } from './workflow-runner.js';

const { logWorkflowRunMock, writeWorkflowSnapshotMock } = vi.hoisted(() => ({
  logWorkflowRunMock: vi.fn(),
  writeWorkflowSnapshotMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../telemetry/loggers.js', () => ({
  logWorkflowRun: logWorkflowRunMock,
}));

vi.mock('../workflow-snapshot.js', () => ({
  writeWorkflowSnapshot: writeWorkflowSnapshotMock,
}));

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
    if (entry && entry.status !== 'running') {
      terminalStatuses.push(entry.status);
    }
  });
  return { abortCount: () => aborts, terminalStatuses };
}

describe('WorkflowRunner', () => {
  beforeEach(() => {
    logWorkflowRunMock.mockClear();
    writeWorkflowSnapshotMock.mockClear();
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
});
