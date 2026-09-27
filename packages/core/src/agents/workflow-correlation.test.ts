/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import {
  MAX_WORKFLOW_CALL_TRACES,
  readWorkflowSourceRef,
  type WorkflowCallTrace,
} from './workflow-correlation.js';
import { WorkflowRunner } from './runtime/workflow-runner.js';
import { WorkflowOrchestrator } from './runtime/workflow-orchestrator.js';
import { WorkflowJournal, buildReplay } from './runtime/workflow-journal.js';
import {
  WorkflowRunRegistry,
  type WorkflowDispatchQueued,
} from './workflow-run-registry.js';
import { listWorkflowSnapshots } from './workflow-snapshot.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'workflow-correlation-'),
  );
  roots.push(root);
  const registry = new WorkflowRunRegistry();
  const config = {
    getWorkflowRunRegistry: () => registry,
    storage: {
      getWorkflowRunsDir: () => root,
      getWorkflowRunJournalPath: (id: string) =>
        path.join(root, id, 'journal.jsonl'),
      getWorkflowRunSnapshotPath: (id: string) => path.join(root, `${id}.json`),
      getGeneratedWorkflowsDir: () => path.join(root, 'generated'),
      getInlineWorkflowScriptPath: (id: string) =>
        path.join(root, 'generated', 'inline', `${id}.js`),
    },
  } as unknown as Config;
  return { root, registry, config };
}

describe('native workflow correlation', () => {
  it('persists source before dispatch and resumes with new step IDs without cache misses', async () => {
    const { config, registry } = await fixture();
    const sourceRef = { id: 'daily-report', revision: 'r1' };
    const dispatch = vi.fn(async () => {
      const task = registry.list()[0];
      const text = await fs.readFile(
        config.storage.getWorkflowRunJournalPath(task.runId),
        'utf8',
      );
      // Both records are on disk before the first agent is dispatched: the
      // run's `launched` line, then the source it was started from.
      const lines = text.split('\n');
      expect(JSON.parse(lines[0])).toEqual({ type: 'launched', version: 1 });
      expect(JSON.parse(lines[1])).toEqual({
        type: 'source',
        version: 1,
        sourceRef,
      });
      return 'done';
    });
    const first = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      toolUseId: 'tool-1',
      script: "return await agent('same work', {stepId: 'before'});",
      args: { day: 1 },
      sourceRef,
      dispatch,
    });
    expect((await first.completion).ok).toBe(true);
    sourceRef.revision = 'changed-after-start';
    expect(first.sourceRef).toEqual({ id: 'daily-report', revision: 'r1' });
    const second = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      toolUseId: 'tool-2',
      script: "return await agent('same work', {stepId: 'after'});",
      args: { day: 1 },
      resumeFromRunId: first.runId,
      dispatch,
    });
    expect((await second.completion).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(registry.get(first.runId)).toMatchObject({
      toolUseId: 'tool-2',
      sourceRef: { id: 'daily-report', revision: 'r1' },
      dispatches: [{ stepId: 'after', status: 'cached' }],
    });
    expect(await listWorkflowSnapshots(config)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRef: { id: 'daily-report', revision: 'r1' },
          toolUseId: 'tool-2',
        }),
      ]),
    );
    await expect(
      WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return 1;',
        args: {},
        resumeFromRunId: first.runId,
        sourceRef: { id: 'daily-report', revision: 'r2' },
        dispatch,
      }),
    ).rejects.toThrow('must match the original journal');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('recovers source after restart without reading snapshots', async () => {
    const { config, registry } = await fixture();
    const first = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return 1;',
      args: undefined,
      sourceRef: { id: 'flow', revision: 'v1' },
      dispatch: vi.fn(),
    });
    await first.completion;
    await fs.unlink(config.storage.getWorkflowRunSnapshotPath(first.runId));
    registry.reset();
    const resumed = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return 2;',
      args: undefined,
      resumeFromRunId: first.runId,
      dispatch: vi.fn(),
    });
    expect(resumed.sourceRef).toEqual({ id: 'flow', revision: 'v1' });
    expect((await resumed.completion).ok).toBe(true);
  });

  it('requires durable metadata only for callers that opt in', async () => {
    const registry = new WorkflowRunRegistry();
    const config = {
      getWorkflowRunRegistry: () => registry,
    } as unknown as Config;
    const dispatch = vi.fn(async () => 'ok');
    const base = {
      config,
      signal: new AbortController().signal,
      script: "return agent('work');",
      args: undefined,
      dispatch,
    };
    await expect(
      WorkflowRunner.start({ ...base, sourceRef: { id: 'f', revision: 'r' } }),
    ).rejects.toThrow('writable resume journal');
    expect(dispatch).not.toHaveBeenCalled();
    const old = await WorkflowRunner.start(base);
    expect((await old.completion).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('rejects corrupted persisted call statuses instead of coercing them', async () => {
    const { config } = await fixture();
    const handle = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return 1;',
      args: undefined,
      dispatch: vi.fn(),
    });
    await handle.completion;
    const snapshotPath = config.storage.getWorkflowRunSnapshotPath(
      handle.runId,
    );
    const snapshot: Record<string, unknown> = JSON.parse(
      await fs.readFile(snapshotPath, 'utf8'),
    );
    const call = {
      id: 'workflow-call-1',
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
    };
    await fs.writeFile(
      snapshotPath,
      JSON.stringify({ ...snapshot, workflowCalls: [call] }),
    );
    expect(await listWorkflowSnapshots(config)).toHaveLength(1);
    for (const status of [['completed'], null, 1]) {
      await fs.writeFile(
        snapshotPath,
        JSON.stringify({ ...snapshot, workflowCalls: [{ ...call, status }] }),
      );
      expect(await listWorkflowSnapshots(config)).toEqual([]);
    }
  });

  it('does not dispatch when writing source metadata fails', async () => {
    const { config, registry } = await fixture();
    vi.spyOn(WorkflowJournal.prototype, 'append').mockRejectedValue(
      new Error('disk full'),
    );
    const dispatch = vi.fn();
    await expect(
      WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: "return agent('work');",
        args: undefined,
        sourceRef: { id: 'f', revision: 'r' },
        dispatch,
      }),
    ).rejects.toThrow('disk full');
    expect(dispatch).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  it('does not attach new attribution to a legacy journal', async () => {
    const { config } = await fixture();
    const first = await WorkflowRunner.start({
      config,
      signal: new AbortController().signal,
      script: 'return 1;',
      args: undefined,
      dispatch: vi.fn(),
    });
    await first.completion;
    await expect(
      WorkflowRunner.start({
        config,
        signal: new AbortController().signal,
        script: 'return 2;',
        args: undefined,
        resumeFromRunId: first.runId,
        sourceRef: { id: 'f', revision: 'r' },
        dispatch: vi.fn(),
      }),
    ).rejects.toThrow('must match the original journal');
  });

  it('keeps same-name parallel calls separate from their internal step IDs', async () => {
    const calls: WorkflowCallTrace[] = [];
    const dispatches: WorkflowDispatchQueued[] = [];
    const runner = new WorkflowOrchestrator(async (prompt) => prompt);
    const result = await runner.run({
      script:
        "return parallel([() => workflow('ext:check', 'left', {stepId:'node-a'}), () => workflow('ext:check', 'right', {stepId:'node-b'})]);",
      args: undefined,
      resolveSavedWorkflow: async () => ({
        name: 'ext:check',
        script: "return agent(args, {stepId:'internal'});",
      }),
      emitter: {
        workflowCallUpdated: (call) => calls.push(call),
        dispatchQueued: (event) => dispatches.push(event),
      },
    });
    expect(result.result).toEqual(['left', 'right']);
    const completed = calls.filter((call) => call.status === 'completed');
    expect(completed).toHaveLength(2);
    expect(new Set(completed.map((call) => call.id)).size).toBe(2);
    for (const [prompt, node] of [
      ['left', 'node-a'],
      ['right', 'node-b'],
    ]) {
      const dispatch = dispatches.find((event) => event.prompt === prompt)!;
      expect(dispatch.stepId).toBe('internal');
      expect(
        completed.find((call) => call.id === dispatch.workflowCallId)?.stepId,
      ).toBe(node);
    }
  });

  it('observes empty calls and post-agent failures without changing caught errors', async () => {
    const calls: WorkflowCallTrace[] = [];
    const runner = new WorkflowOrchestrator(async () => 'ok');
    const outcome = await runner.run({
      script:
        "const value = await workflow('empty'); for (const name of ['missing','post']) { try { await workflow(name); } catch {} } return value;",
      args: undefined,
      resolveSavedWorkflow: async (name) => {
        if (name === 'missing') throw new Error('lookup failure');
        return {
          script:
            name === 'empty'
              ? 'return 42;'
              : "await agent('x'); throw new Error('post-processing failed');",
        };
      },
      emitter: { workflowCallUpdated: (call) => calls.push(call) },
    });
    expect(outcome.result).toBe(42);
    expect(calls.filter((call) => call.endedAt !== undefined)).toMatchObject([
      { workflowName: 'empty', status: 'completed' },
      { workflowName: 'missing', status: 'failed', error: 'lookup failure' },
      {
        workflowName: 'post',
        status: 'failed',
        error: 'post-processing failed',
      },
    ]);
  });

  it('keeps telemetry failures out of workflow results', async () => {
    const runner = new WorkflowOrchestrator(async () => 'ok');
    const outcome = await runner.run({
      script: "return workflow('empty');",
      args: undefined,
      resolveSavedWorkflow: async () => ({ script: 'return null;' }),
      emitter: {
        workflowCallUpdated: () => {
          throw new Error('observer failure');
        },
      },
    });
    expect(outcome.result).toBeNull();
  });

  it.each([null, '', ' padded', 'x\n', 42, { id: 'x' }, 'x'.repeat(129)])(
    'rejects invalid step IDs before dispatch: %j',
    async (stepId) => {
      const dispatch = vi.fn();
      const resolve = vi.fn(async () => ({ script: 'return 1;' }));
      for (const call of [
        "agent('x', {stepId: args})",
        "workflow('x', {}, {stepId: args})",
      ]) {
        await expect(
          new WorkflowOrchestrator(dispatch).run({
            script: `return ${call};`,
            args: stepId,
            resolveSavedWorkflow: resolve,
          }),
        ).rejects.toThrow('stepId');
      }
      expect(dispatch).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('bounds call records without changing native Agent counts', async () => {
    const { registry } = await fixture();
    registry.register({
      runId: 'wf_a',
      meta: null,
      status: 'running',
      startTime: 0,
      outputFile: '',
      abortController: new AbortController(),
    });
    for (let i = 0; i <= MAX_WORKFLOW_CALL_TRACES; i++) {
      registry.onWorkflowCallUpdated('wf_a', {
        id: `call-${i}`,
        startedAt: i,
        status: 'running',
      });
    }
    expect(registry.get('wf_a')).toMatchObject({
      workflowCallsTruncated: true,
      agentsDispatched: 0,
    });
    expect(registry.get('wf_a')?.workflowCalls).toHaveLength(
      MAX_WORKFLOW_CALL_TRACES,
    );
    registry.cancel('wf_a', 1234);
    expect(
      registry
        .get('wf_a')
        ?.workflowCalls?.every((call) => call.status === 'cancelled'),
    ).toBe(true);
  });

  it('rejects contradictory journal attribution while retaining legacy replay maps', () => {
    expect(
      buildReplay([
        { type: 'source', version: 1, sourceRef: { id: 'f', revision: '1' } },
        { type: 'source', version: 1, sourceRef: { id: 'f', revision: '2' } },
      ]).sourceError,
    ).toBeTruthy();
    expect(buildReplay([])).toEqual({
      results: new Map(),
      started: new Map(),
      failed: new Set(),
    });
    expect(() =>
      readWorkflowSourceRef({ id: 'f', revision: '1', extra: true }),
    ).toThrow('sourceRef');
  });
});
