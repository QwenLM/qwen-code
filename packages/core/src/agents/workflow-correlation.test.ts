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
import { readWorkflowSourceRef } from './workflow-correlation.js';
import { WorkflowRunner } from './runtime/workflow-runner.js';
import { WorkflowJournal, buildReplay } from './runtime/workflow-journal.js';
import { WorkflowRunRegistry } from './workflow-run-registry.js';
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
  it('persists source before dispatch and preserves it on cached resume', async () => {
    const { config, registry } = await fixture();
    const sourceRef = { id: 'daily-report', revision: 'r1' };
    const dispatch = vi.fn(async () => {
      const task = registry.list()[0];
      const text = await fs.readFile(
        config.storage.getWorkflowRunJournalPath(task.runId),
        'utf8',
      );
      expect(JSON.parse(text.split('\n')[0])).toEqual({
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
      script: "return await agent('same work', {});",
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
      script: "return await agent('same work', {});",
      args: { day: 1 },
      resumeFromRunId: first.runId,
      dispatch,
    });
    expect((await second.completion).ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(registry.get(first.runId)).toMatchObject({
      toolUseId: 'tool-2',
      sourceRef: { id: 'daily-report', revision: 'r1' },
      dispatches: [{ status: 'cached' }],
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
