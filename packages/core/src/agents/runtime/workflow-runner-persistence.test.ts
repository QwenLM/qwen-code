/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { WorkflowRunRegistry } from '../workflow-run-registry.js';
import * as workflowSnapshot from '../workflow-snapshot.js';
import { readWorkflowManifest } from '../workflow-snapshot.js';
import { WorkflowJournal } from './workflow-journal.js';
import { WorkflowRunner } from './workflow-runner.js';

describe('WorkflowRunner persistence', () => {
  const tempDirs: string[] = [];

  async function harness(): Promise<{
    config: Config;
    registry: WorkflowRunRegistry;
    storage: Storage;
  }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-runner-store-'));
    tempDirs.push(root);
    const registry = new WorkflowRunRegistry();
    const storage = new Storage(root, path.join(root, 'runtime'));
    const config = {
      storage,
      getCliVersion: () => 'test-version',
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    return { config, registry, storage };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('writes an initial manifest before returning and a compatible terminal snapshot', async () => {
    const { config, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: { topic: 'durability' },
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });

    const running = await readWorkflowManifest(config, handle.runId);
    expect(running.status).toBe('running');
    expect(running.args).toEqual({ topic: 'durability' });

    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    finishDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    const completed = await readWorkflowManifest(config, handle.runId);
    expect(completed.status).toBe('completed');
    await expect(
      fs.readFile(storage.getWorkflowRunSnapshotPath(handle.runId), 'utf8'),
    ).resolves.toContain('"status": "completed"');
  });

  it('keeps the run pausing until its flushed checkpoint is atomically published', async () => {
    const { config, registry } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const originalFlush = WorkflowJournal.prototype.flush;
    let releaseCheckpoint: (() => void) | undefined;
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const flushSpy = vi
      .spyOn(WorkflowJournal.prototype, 'flush')
      .mockImplementationOnce(async function (this: WorkflowJournal) {
        const checkpoint = await originalFlush.call(this);
        await checkpointGate;
        return checkpoint;
      });

    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');
    await vi.waitFor(() => expect(flushSpy).toHaveBeenCalledOnce());
    expect(registry.get(handle.runId)?.status).toBe('pausing');
    expect((await readWorkflowManifest(config, handle.runId)).status).toBe(
      'running',
    );

    releaseCheckpoint?.();
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );
    expect((await readWorkflowManifest(config, handle.runId)).status).toBe(
      'paused',
    );

    expect(handle.resume()).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
  });

  // The pause barrier is entered from a dispatch's `.finally`, so nothing
  // awaits it. A cancel landing while the barrier is mid-write used to
  // publish the terminal manifest first and have the barrier's 'paused' +
  // canResume write land on top — a cancelled run that resume() re-executes.
  it('does not let a mid-barrier pause write outlive the terminal manifest', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const originalWrite = workflowSnapshot.writeWorkflowManifest;
    const statuses: Array<string | undefined> = [];
    let releasePaused: (() => void) | undefined;
    const pausedGate = new Promise<void>((resolve) => {
      releasePaused = resolve;
    });
    vi.spyOn(workflowSnapshot, 'writeWorkflowManifest').mockImplementation(
      async (...args: Parameters<typeof originalWrite>) => {
        const status = args[2].status;
        statuses.push(status);
        if (status === 'paused') await pausedGate;
        return originalWrite(...args);
      },
    );

    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');
    await vi.waitFor(() => expect(statuses).toContain('paused'));
    // The barrier has flushed and is inside its 'paused' + canResume write.
    registry.cancel(handle.runId, Date.now());
    releasePaused?.();

    await expect(handle.completion).resolves.toMatchObject({ ok: false });
    expect(registry.get(handle.runId)?.status).toBe('cancelled');
    // Read the file directly: a surviving 'paused' manifest also trips the
    // terminal-snapshot conflict in readWorkflowManifest, which would mask
    // which of the two writes actually landed last.
    const durable = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunManifestPath(handle.runId),
        'utf8',
      ),
    ) as { status: string; canResume: boolean };
    expect(durable).toMatchObject({ status: 'cancelled', canResume: false });
  });

  it('fails the run instead of publishing paused when the manifest cannot be replaced', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const manifestPath = storage.getWorkflowRunManifestPath(handle.runId);
    const blockedManifest = storage.getWorkflowRunManifestPath(handle.runId);
    await fs.rm(manifestPath);
    await fs.mkdir(blockedManifest);

    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/pause checkpoint/i),
    });
    expect(registry.get(handle.runId)?.status).toBe('failed');
    expect(registry.get(handle.runId)?.error).toMatch(/pause checkpoint/i);
    expect((await fs.lstat(blockedManifest)).isDirectory()).toBe(true);
  });

  it('does not publish success when the terminal manifest cannot be replaced', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const manifestPath = storage.getWorkflowRunManifestPath(handle.runId);
    const blockedManifest = storage.getWorkflowRunManifestPath(handle.runId);
    await fs.rm(manifestPath);
    await fs.mkdir(blockedManifest);

    finishDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/terminal checkpoint/i),
    });
    expect(registry.get(handle.runId)?.status).toBe('failed');
    expect(registry.get(handle.runId)?.error).toMatch(/terminal checkpoint/i);
    expect((await fs.lstat(blockedManifest)).isDirectory()).toBe(true);
  });

  // The background controller is deliberately unlinked from the caller
  // signal, so the pre-start check is the only read of it — and this PR put
  // an fsync between that check and dispatch. An Esc landing in that window
  // used to start the run anyway and report "started in background".
  it('cancels a background start when the abort lands during the initial checkpoint', async () => {
    const { config, registry } = await harness();
    const dispatch = vi.fn(async () => 'must not run');
    const caller = new AbortController();

    const originalFlush = WorkflowJournal.prototype.flush;
    vi.spyOn(WorkflowJournal.prototype, 'flush').mockImplementationOnce(
      async function (this: WorkflowJournal) {
        const checkpoint = await originalFlush.call(this);
        caller.abort();
        return checkpoint;
      },
    );

    await expect(
      WorkflowRunner.start({
        config,
        signal: caller.signal,
        script: 'return await agent("work")',
        args: null,
        runInBackground: true,
        dispatch,
      }),
    ).rejects.toThrow(/Background workflow start was cancelled/);

    expect(dispatch).not.toHaveBeenCalled();
    // The initial persist already wrote 'running' + resumable; leaving it
    // there would advertise a cancelled run as recoverable forever.
    const active = registry.list().filter((run) => run.status === 'running');
    expect(active).toEqual([]);
  });

  it('drops a crash suffix before a resumed run publishes a new checkpoint', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const script = 'return await agent("work")';
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script,
      args: { topic: 'resume' },
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    expect(handle.pause()).toBe(true);
    finishDispatch?.('cached');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );

    await fs.appendFile(
      storage.getWorkflowRunJournalPath(handle.runId),
      '{partial',
    );
    const resumedRegistry = new WorkflowRunRegistry();
    const resumedConfig = {
      storage,
      getCliVersion: () => 'test-version',
      getWorkflowRunRegistry: () => resumedRegistry,
    } as unknown as Config;
    const resumedDispatch = vi.fn(async () => 'must not run');
    const resumed = await WorkflowRunner.start({
      config: resumedConfig,
      signal: new AbortController().signal,
      script,
      args: { topic: 'resume' },
      resumeFromRunId: handle.runId,
      dispatch: resumedDispatch,
    });

    await expect(resumed.completion).resolves.toMatchObject({ ok: true });
    expect(resumedDispatch).not.toHaveBeenCalled();
    const manifest = await readWorkflowManifest(resumedConfig, handle.runId);
    await expect(
      new WorkflowJournal(storage.getWorkflowRunJournalPath(handle.runId)).load(
        manifest.journal,
      ),
    ).resolves.toMatchObject({
      results: expect.any(Map),
      started: expect.any(Map),
    });

    registry.cancel(handle.runId, Date.now());
    await expect(handle.completion).resolves.toMatchObject({ ok: false });
  });

  it('refuses script or args drift instead of silently starting a fresh resume', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const script = 'return await agent("work")';
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script,
      args: { topic: 'original' },
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');
    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );

    const freshRegistry = new WorkflowRunRegistry();
    const freshConfig = {
      storage,
      getCliVersion: () => 'test-version',
      getWorkflowRunRegistry: () => freshRegistry,
    } as unknown as Config;
    await expect(
      WorkflowRunner.start({
        config: freshConfig,
        signal: new AbortController().signal,
        script: `${script}\n// changed`,
        args: { topic: 'original' },
        resumeFromRunId: handle.runId,
        dispatch: async () => 'unused',
      }),
    ).rejects.toThrow(/script.*manifest/i);
    await expect(
      WorkflowRunner.start({
        config: freshConfig,
        signal: new AbortController().signal,
        script,
        args: { topic: 'changed' },
        resumeFromRunId: handle.runId,
        dispatch: async () => 'unused',
      }),
    ).rejects.toThrow(/args.*manifest/i);

    registry.cancel(handle.runId, Date.now());
    await expect(handle.completion).resolves.toMatchObject({ ok: false });
  });

  it('persists cancellation after draining the journal', async () => {
    const { config, registry } = await harness();
    let rejectDispatch: ((error: Error) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    });
    await vi.waitFor(() => expect(rejectDispatch).toBeDefined());

    registry.cancel(handle.runId, Date.now());
    rejectDispatch?.(new Error('cancelled'));
    await expect(handle.completion).resolves.toMatchObject({ ok: false });

    const manifest = await readWorkflowManifest(config, handle.runId);
    expect(manifest.status).toBe('cancelled');
    expect(manifest.journal.integrity).toBe('complete');
    expect(manifest.journal.byteLength).toBeGreaterThan(0);
    const replay = await new WorkflowJournal(
      config.storage!.getWorkflowRunJournalPath(handle.runId),
    ).load(manifest.journal);
    expect(replay.started.size).toBe(1);
  });

  it('does not report success when cancellation wins during terminal flush', async () => {
    const { config, registry } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const originalFlush = WorkflowJournal.prototype.flush;
    let releaseFlush: (() => void) | undefined;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const flushSpy = vi
      .spyOn(WorkflowJournal.prototype, 'flush')
      .mockImplementationOnce(async function (this: WorkflowJournal) {
        const checkpoint = await originalFlush.call(this);
        await flushGate;
        return checkpoint;
      });

    finishDispatch?.('done');
    await vi.waitFor(() => expect(flushSpy).toHaveBeenCalledOnce());
    registry.cancel(handle.runId, Date.now());
    releaseFlush?.();

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Workflow run cancelled.',
    });
    expect((await readWorkflowManifest(config, handle.runId)).status).toBe(
      'cancelled',
    );
  });

  it('does not report success when cancellation wins during terminal manifest publication', async () => {
    const { config, registry } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const originalWrite = workflowSnapshot.writeWorkflowManifest;
    let releaseManifest: (() => void) | undefined;
    const manifestGate = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const manifestSpy = vi
      .spyOn(workflowSnapshot, 'writeWorkflowManifest')
      .mockImplementationOnce(async (...args) => {
        await manifestGate;
        return originalWrite(...args);
      });

    finishDispatch?.('done');
    await vi.waitFor(() => expect(manifestSpy).toHaveBeenCalledOnce());
    registry.cancel(handle.runId, Date.now());
    releaseManifest?.();

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'Workflow run cancelled.',
    });
    expect((await readWorkflowManifest(config, handle.runId)).status).toBe(
      'cancelled',
    );
  });

  it('settles failed even when every terminal journal flush rejects', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return await agent("work")',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    vi.spyOn(WorkflowJournal.prototype, 'flush').mockRejectedValue(
      new Error('terminal flush broke'),
    );

    finishDispatch?.('done');

    await expect(handle.completion).resolves.toMatchObject({
      ok: false,
      message: 'terminal flush broke',
    });
    expect(registry.get(handle.runId)).toMatchObject({
      status: 'failed',
      error: 'terminal flush broke',
    });
    await expect(
      fs.readFile(storage.getWorkflowRunSnapshotPath(handle.runId), 'utf8'),
    ).resolves.toContain('"status": "failed"');
  });

  it('persists wall-clock timeout as a failed terminal checkpoint', async () => {
    vi.useFakeTimers();
    const originalTimeout = process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'];
    process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS'] = '1';
    try {
      const { config } = await harness();
      const handle = await WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'await new Promise(() => {})',
        args: null,
        runInBackground: true,
        dispatch: async () => 'unused',
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(handle.completion).resolves.toMatchObject({ ok: false });
      const manifest = await readWorkflowManifest(config, handle.runId);
      expect(manifest.status).toBe('failed');
      expect(manifest.journal.integrity).toBe('complete');
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
