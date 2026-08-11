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
import { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
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

  // Joining the barrier only covers the one that exists at join time. The
  // terminal flush + manifest write that follows is a second window: a pause
  // landing inside it used to be admitted (the entry is still 'running' until
  // registry.complete), start a barrier nothing joined, and race its 'paused' +
  // canResume write against the terminal write — which trips atomicWriteFile's
  // inode guard and settles a normally-completed run as failed.
  it('refuses a pause that lands while the terminal manifest is being written', async () => {
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
    let releaseCompleted: (() => void) | undefined;
    const completedGate = new Promise<void>((resolve) => {
      releaseCompleted = resolve;
    });
    vi.spyOn(workflowSnapshot, 'writeWorkflowManifest').mockImplementation(
      async (...args: Parameters<typeof originalWrite>) => {
        const status = args[2].status;
        statuses.push(status);
        if (status === 'completed') await completedGate;
        return originalWrite(...args);
      },
    );

    finishDispatch?.('done');
    await vi.waitFor(() => expect(statuses).toContain('completed'));
    // Settlement is parked inside the terminal manifest write. The registry
    // entry still reads 'running', so registry.pause's own guard admits this.
    expect(registry.get(handle.runId)?.status).toBe('running');
    expect(registry.pause(handle.runId)).toBe(false);
    releaseCompleted?.();

    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    expect(registry.get(handle.runId)?.status).toBe('completed');
    expect(statuses).not.toContain('paused');
    const durable = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunManifestPath(handle.runId),
        'utf8',
      ),
    ) as { status: string; canResume: boolean };
    expect(durable).toMatchObject({ status: 'completed', canResume: false });
  });

  // The catch path's join is the only ordering guarantee between an
  // error/cancel settlement and a barrier that is already mid-write. The
  // finally block's re-persist heals the end state, so this pins the ordering
  // itself: no 'paused' write may land after a terminal one, or a crash inside
  // the window leaves a failed run advertised as resumable.
  it('orders an error settlement after a barrier that is already mid-write', async () => {
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      // Two dispatches, because reaching the catch path takes some care: a
      // rejecting dispatch is retried and the retry parks behind the pause
      // gate, and a paused run holds even a *completed* dispatch's result
      // gate, so the script cannot throw on its own either. The cancel below
      // releases the first gate, and the second `agent()` then rejects
      // immediately against the aborted signal — which is what unwinds the
      // script into the catch path.
      script: 'await agent("a"); await agent("b");',
      args: null,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const originalWrite = workflowSnapshot.writeWorkflowManifest;
    const started: Array<string | undefined> = [];
    const committed: Array<string | undefined> = [];
    let releasePaused: (() => void) | undefined;
    const pausedGate = new Promise<void>((resolve) => {
      releasePaused = resolve;
    });
    vi.spyOn(workflowSnapshot, 'writeWorkflowManifest').mockImplementation(
      async (...args: Parameters<typeof originalWrite>) => {
        const status = args[2].status;
        started.push(status);
        if (status === 'paused') await pausedGate;
        const result = await originalWrite(...args);
        committed.push(status);
        return result;
      },
    );

    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');
    // The barrier is entered from the dispatch's `.finally` and is now parked
    // inside its 'paused' + canResume write.
    await vi.waitFor(() => expect(started).toContain('paused'));
    registry.cancel(handle.runId, Date.now());
    // Give the catch path room to reach its terminal write while the barrier
    // is still mid-write. With the join it stays parked; without it, the
    // 'cancelled' write lands here — inside the barrier's window.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(committed).not.toContain('cancelled');
    releasePaused?.();

    await expect(handle.completion).resolves.toMatchObject({ ok: false });
    expect(registry.get(handle.runId)?.status).toBe('cancelled');
    // The invariant: the barrier really ran, and every terminal write landed
    // after it.
    const lastPaused = committed.lastIndexOf('paused');
    const firstTerminal = committed.findIndex(
      (status) => status === 'failed' || status === 'cancelled',
    );
    expect(lastPaused).toBeGreaterThanOrEqual(0);
    expect(firstTerminal).toBeGreaterThan(lastPaused);
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

  it('degrades a pause to canResume:false instead of killing the run when the checkpoint fails', async () => {
    // The contrast to the test above: there the manifest write itself failed,
    // so there was no durable record of the pause and killing the run is right.
    // Here the write is fine and only the checkpoint came back 'failed' — which
    // is what both trigger classes look like, a journal grown past
    // MAX_WORKFLOW_JOURNAL_BYTES and the sticky `writeError` latch left by one
    // transient append failure, since flush() folds each into integrity
    // 'failed' rather than throwing. The terminal paths already accept exactly
    // this checkpoint, so asserting completeness only on the pause path turned
    // the user's next pause into a hard kill of a healthy run — aborting its
    // in-flight and queued agents — and contradicted the cap's own documented
    // promise that resumability is lost while the journal stays intact.
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

    // Installed after start(), so the initial checkpoint — the one transition
    // that legitimately still refuses — is untouched.
    const originalFlush = WorkflowJournal.prototype.flush;
    vi.spyOn(WorkflowJournal.prototype, 'flush').mockImplementation(
      async function (this: WorkflowJournal) {
        const checkpoint = await originalFlush.call(this);
        return {
          ...checkpoint,
          integrity: 'failed' as const,
          error: 'Workflow journal is too large',
        };
      },
    );

    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');

    await vi.waitFor(() =>
      expect(registry.get(handle.runId)?.status).toBe('paused'),
    );
    expect(registry.get(handle.runId)?.error).toBeUndefined();

    const manifest = await readWorkflowManifest(config, handle.runId);
    expect(manifest).toMatchObject({ status: 'paused', canResume: false });
    expect(manifest.resumeBlockedReason).toMatch(/too large/i);
    expect(manifest.journal.integrity).toBe('failed');

    // Drain the run so the suite leaves nothing pending.
    vi.restoreAllMocks();
    expect(handle.resume()).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
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

    // The stale original runner's teardown must not relabel the resumed
    // run's terminal state: its settlement persists lose the generation CAS
    // (the resumed run owns the run now), and an evicted writer publishes
    // no legacy snapshot. Re-read both artifacts — the corruption this test
    // used to ship green was exactly these two files saying 'cancelled'.
    const durable = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunManifestPath(handle.runId),
        'utf8',
      ),
    ) as { status: string };
    expect(durable.status).toBe('completed');
    const snapshot = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunSnapshotPath(handle.runId),
        'utf8',
      ),
    ) as { status: string };
    expect(snapshot.status).toBe('completed');
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

  // The barrier's catch used to kill the run unconditionally. A settlement
  // that has already joined the barrier records the terminal state durably
  // on its own; killing anyway flipped a script-completed run to 'failed'
  // and dropped its result whenever the barrier's 'paused' write hit a
  // transient fs error the very next write survived.
  it('does not kill a successful run when the barrier write fails after settlement joined', async () => {
    // Foreground run: the caller abort below releases the paused result
    // gate WITHOUT touching the registry entry, the script completes on the
    // delivered result, and settlement joins the barrier while its 'paused'
    // write is still gated in flight. Only then does the write fail — the
    // old unconditional kill flipped the successful settlement to 'failed'
    // and dropped the result; with settlement already joined, the barrier
    // must stand down and let the settlement record the terminal state.
    const { config, registry, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const caller = new AbortController();
    const handle = await WorkflowRunner.start({
      config,
      signal: caller.signal,
      script: 'return await agent("work")',
      args: null,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());

    const originalWrite = workflowSnapshot.writeWorkflowManifest;
    const started: Array<string | undefined> = [];
    let releasePaused: (() => void) | undefined;
    const pausedGate = new Promise<void>((resolve) => {
      releasePaused = resolve;
    });
    vi.spyOn(workflowSnapshot, 'writeWorkflowManifest').mockImplementation(
      async (...args: Parameters<typeof originalWrite>) => {
        const status = args[2].status;
        started.push(status);
        if (status === 'paused') {
          await pausedGate;
          throw new Error('ENOSPC: simulated barrier write failure');
        }
        return originalWrite(...args);
      },
    );
    const beginSettlingSpy = vi.spyOn(
      WorkflowDispatchScheduler.prototype,
      'beginSettling',
    );

    expect(handle.pause()).toBe(true);
    finishDispatch?.('done');
    await vi.waitFor(() => expect(started).toContain('paused'));
    // The barrier is parked inside its 'paused' write. The abort releases
    // the held dispatch result, the script completes, and settlement joins
    // the in-flight barrier.
    caller.abort();
    await vi.waitFor(() => expect(beginSettlingSpy).toHaveBeenCalled());
    releasePaused?.();

    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    expect(registry.get(handle.runId)?.status).toBe('completed');
    const durable = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunManifestPath(handle.runId),
        'utf8',
      ),
    ) as { status: string; canResume: boolean };
    expect(durable).toMatchObject({ status: 'completed', canResume: false });
  });

  // An in-process duplicate resume must be refused before the durable
  // manifest is touched: acquiring ownership first committed the generation
  // CAS under the refused caller's nonce, evicting the live run's next
  // persist on behalf of a writer that never started.
  it('refuses an in-process duplicate resume without mutating the durable manifest', async () => {
    const { config, storage } = await harness();
    let finishDispatch: ((value: string) => void) | undefined;
    const script = 'return await agent("work")';
    const args = { topic: 'duplicate' };
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script,
      args,
      runInBackground: true,
      dispatch: () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    });
    await vi.waitFor(() => expect(finishDispatch).toBeDefined());
    const manifestPath = storage.getWorkflowRunManifestPath(handle.runId);
    const before = await fs.readFile(manifestPath, 'utf8');

    await expect(
      WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script,
        args,
        resumeFromRunId: handle.runId,
        dispatch: vi.fn(async () => 'must not run'),
      }),
    ).rejects.toThrow(/already active/);

    expect(await fs.readFile(manifestPath, 'utf8')).toBe(before);

    // The live run still owns its manifests: its next persist advances.
    finishDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    const after = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      status: string;
    };
    expect(after.status).toBe('completed');
  });

  it('stamps generation and owner on a fresh run from its first manifest', async () => {
    const { config } = await harness();
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

    // The first writer of a run is the prior writer every later resume
    // races against, so even a fresh start's initial manifest carries the
    // CAS stamp.
    const manifest = await readWorkflowManifest(config, handle.runId);
    expect(manifest.generation).toBe(1);
    expect(manifest.owner).toMatchObject({ pid: process.pid });

    finishDispatch?.('done');
    await expect(handle.completion).resolves.toMatchObject({ ok: true });
    const completed = await readWorkflowManifest(config, handle.runId);
    // Gen 2 is the try-path 'completed' write; gen 3 the finally re-persist.
    expect(completed.generation).toBe(3);
    expect(completed.owner?.nonce).toBe(manifest.owner?.nonce);
  });

  it('projects the settlement result once and writes the same value everywhere', async () => {
    const { config, storage } = await harness();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      // Built INSIDE the sandbox: agent() returns are revived at the vm
      // boundary, but the script's own return is not detached, so a live
      // `toJSON()` rides into settlement. The settlement must project it
      // ONCE — if either persisted writer re-serialized the live object,
      // `calls` would advance past 1 and the artifacts would disagree.
      script:
        'let calls = 0; return { toJSON: () => ({ projected: true, calls: ++calls }) };',
      args: null,
      runInBackground: true,
      dispatch: async () => 'unused',
    });
    await expect(handle.completion).resolves.toMatchObject({ ok: true });

    const manifest = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunManifestPath(handle.runId),
        'utf8',
      ),
    ) as { result: unknown };
    expect(manifest.result).toEqual({ projected: true, calls: 1 });
    const snapshot = JSON.parse(
      await fs.readFile(
        storage.getWorkflowRunSnapshotPath(handle.runId),
        'utf8',
      ),
    ) as { result: unknown };
    expect(snapshot.result).toEqual({ projected: true, calls: 1 });
  });
});
