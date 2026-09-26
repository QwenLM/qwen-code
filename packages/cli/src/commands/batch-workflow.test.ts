/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runPlan,
  collectTask,
  retryTask,
  cancelTask,
  listTasks,
  checkReadiness,
  cleanTask,
  type WorkflowApi,
  type WorkflowDeps,
} from './batch-workflow.js';
import { BatchTaskStore } from './batch-task.js';
import type { BatchJob } from './batch.js';

const outputLine = (customId: string, content: string) =>
  JSON.stringify({
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content } },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      },
    },
  });

const truncatedLine = (customId: string) =>
  JSON.stringify({
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        choices: [
          {
            finish_reason: 'length',
            message: { role: 'assistant', content: '# partial' },
          },
        ],
      },
    },
  });

/** Request bodies uploaded for the n-th submission (1-based). */
const uploadedBodies = (h: Harness, n: number) =>
  (h.api.uploadJsonl.mock.calls[n - 1][1] as string)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).body as Record<string, unknown>);

const jobOf = (
  id: string,
  status: string,
  files: Partial<BatchJob> = {},
): BatchJob => ({
  id,
  status,
  created_at: 1,
  request_counts: { total: 2, completed: 2, failed: 0 },
  ...files,
});

interface Harness {
  root: string;
  home: string;
  planPath: string;
  api: WorkflowApi & {
    uploadJsonl: ReturnType<typeof vi.fn>;
    createBatch: ReturnType<typeof vi.fn>;
    getBatch: ReturnType<typeof vi.fn>;
    listBatches: ReturnType<typeof vi.fn>;
    downloadFile: ReturnType<typeof vi.fn>;
    deleteFile: ReturnType<typeof vi.fn>;
    cancelBatch: ReturnType<typeof vi.fn>;
  };
  jobs: Map<string, BatchJob>;
  files: Map<string, string>;
  out: string[];
  err: string[];
  deps: WorkflowDeps;
  sleeps: number[];
  store: BatchTaskStore;
}

function setup(planOverrides: Record<string, unknown> = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-wf-project-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-wf-home-'));
  fs.mkdirSync(path.join(root, 'docs', 'zh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'zh', 'a.md'), '# A\n\n甲。\n');
  fs.writeFileSync(path.join(root, 'docs', 'zh', 'b.md'), '# B\n\n乙。\n');
  const plan = {
    version: 1,
    name: 'translate-test',
    kind: 'document-transform',
    shared: { instructions: 'Translate to English. Return only the document.' },
    items: [
      { id: 'a', source: 'docs/zh/a.md', target: 'docs/en/a.md' },
      { id: 'b', source: 'docs/zh/b.md', target: 'docs/en/b.md' },
    ],
    ...planOverrides,
  };
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan));

  const jobs = new Map<string, BatchJob>();
  const files = new Map<string, string>();
  const api = {
    uploadJsonl: vi.fn(async () => ({ id: `file-in-${files.size + 1}` })),
    createBatch: vi.fn(async (_ep: unknown, inputFileId: string) => {
      const job = jobOf(`batch-${jobs.size + 1}`, 'in_progress', {
        input_file_id: inputFileId,
      });
      jobs.set(job.id, job);
      return job;
    }),
    getBatch: vi.fn(async (_ep: unknown, id: string) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`no such batch ${id}`);
      return job;
    }),
    listBatches: vi.fn(async () => [...jobs.values()]),
    downloadFile: vi.fn(
      async (_ep: unknown, fileId: string, target: string) => {
        const content = files.get(fileId);
        if (content === undefined) throw new Error(`no such file ${fileId}`);
        fs.writeFileSync(target, content);
      },
    ),
    deleteFile: vi.fn(async () => undefined),
    cancelBatch: vi.fn(async (_ep: unknown, id: string) => {
      const job = jobs.get(id);
      if (!job) throw new Error(`no such batch ${id}`);
      job.status = 'cancelled';
      return job;
    }),
    probe: vi.fn(async () => undefined),
  };
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const deps: WorkflowDeps = {
    ep: { apiKey: 'k', baseUrl: 'http://fake', model: 'qwen-plus' },
    cwd: root,
    env: { QWEN_BATCH_HOME: home },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    api,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return {
    root,
    home,
    planPath,
    api,
    jobs,
    files,
    out,
    err,
    deps,
    sleeps,
    store: new BatchTaskStore(home),
  };
}

let harness: Harness | undefined;
afterEach(() => {
  if (harness) {
    fs.rmSync(harness.root, { recursive: true, force: true });
    fs.rmSync(harness.home, { recursive: true, force: true });
    harness = undefined;
  }
});

const taskIdOf = (h: Harness) => h.store.list()[0].id;

/** Run a plan whose batch is immediately settled with the given results. */
async function runAndSettle(
  h: Harness,
  results: { output?: string; error?: string },
) {
  await runPlan(h.deps, h.planPath);
  const job = h.jobs.get('batch-1');
  if (!job) throw new Error('expected batch-1');
  job.status = 'completed';
  if (results.output !== undefined) {
    job.output_file_id = 'file-out-1';
    h.files.set('file-out-1', results.output);
  }
  if (results.error !== undefined) {
    job.error_file_id = 'file-err-1';
    h.files.set('file-err-1', results.error);
  }
  return job;
}

describe('runPlan', () => {
  it('uploads once, creates once, and records the whole trail', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);

    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
    expect(h.api.createBatch).toHaveBeenCalledTimes(1);
    const [, jsonl] = h.api.uploadJsonl.mock.calls[0];
    const ids = (jsonl as string)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).custom_id);
    expect(ids).toEqual(['a#1', 'b#1']);

    const task = h.store.load(taskIdOf(h));
    expect(task.status).toBe('running');
    expect(task.items.every((item) => item.state === 'submitted')).toBe(true);
    expect(task.attempts[0]).toMatchObject({
      attempt: 1,
      submitState: 'created',
      batchId: 'batch-1',
      inputFileId: 'file-in-1',
    });
    expect(fs.existsSync(h.store.attemptDir(task.id, 1) + '/input.jsonl')).toBe(
      true,
    );
    expect(h.out.join('\n')).toContain('batch job: batch-1');
    expect(h.out.join('\n')).toContain(`collect ${task.id}`);
  });

  it('keeps the project plans directory out of git', async () => {
    const h = (harness = setup());
    const plansDir = path.join(h.root, '.qwen', 'batch', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.copyFileSync(h.planPath, path.join(plansDir, 'p.json'));
    await runPlan(h.deps, '.qwen/batch/plans/p.json');
    expect(
      fs.readFileSync(
        path.join(h.root, '.qwen', 'batch', '.gitignore'),
        'utf8',
      ),
    ).toBe('*\n');
  });

  it('refuses to submit when a budget is set but unit prices are missing', async () => {
    const h = (harness = setup({ maxCostUsd: 5 }));
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(
      /cannot be enforced/,
    );
    expect(h.api.uploadJsonl).not.toHaveBeenCalled();
    // A refused plan leaves no empty task behind.
    expect(h.store.list()).toHaveLength(0);
  });

  it('refuses to submit when the estimate exceeds the budget', async () => {
    const h = (harness = setup({ maxCostUsd: 0.000001 }));
    h.deps.env = {
      ...h.deps.env,
      QWEN_BATCH_INPUT_PRICE_PER_1M_USD: '2',
      QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD: '6',
    };
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(/exceeds/);
    expect(h.api.uploadJsonl).not.toHaveBeenCalled();
  });

  it('marks items retryable-failed when the provider definitely refuses the create', async () => {
    const h = (harness = setup());
    h.api.createBatch.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 400: bad model'), { status: 400 }),
    );
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(/refused/);
    const task = h.store.load(taskIdOf(h));
    expect(task.items.every((item) => item.state === 'failed')).toBe(true);
    expect(task.attempts[0].submitState).toBe('intent');
    // The orphaned upload is cleaned up because no job can reference it.
    expect(h.api.deleteFile).toHaveBeenCalledWith(h.deps.ep, 'file-in-1');
  });

  it('records an ambiguous create instead of resubmitting, and collect reconciles it', async () => {
    const h = (harness = setup());
    h.files.set(
      'file-out-1',
      `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    );
    h.api.createBatch.mockImplementationOnce(
      async (_ep: unknown, inputFileId: string) => {
        // Provider-side success whose answer never reaches the client.
        h.jobs.set(
          'batch-lost',
          jobOf('batch-lost', 'completed', {
            input_file_id: inputFileId,
            output_file_id: 'file-out-1',
          }),
        );
        throw Object.assign(new Error('HTTP 500: gateway'), { status: 500 });
      },
    );

    // Recorded, then reported as a failure so nobody calls it submitted.
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(
      /may exist and be billing/,
    );
    const task = h.store.load(taskIdOf(h));
    expect(task.status).toBe('submit-unknown');

    await collectTask(h.deps, task.id);
    expect(h.api.createBatch).toHaveBeenCalledTimes(1); // never resubmitted
    const reconciled = h.store.load(task.id);
    expect(reconciled.attempts[0].batchId).toBe('batch-lost');
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
    ).toBe('# A\n\nAlpha.');
  });
});

describe('provider-side rejection', () => {
  const rejected = (id: string, inputFileId: string): BatchJob =>
    jobOf(id, 'failed', {
      input_file_id: inputFileId,
      errors: {
        data: [
          {
            code: 'model_not_found',
            message: 'The model does not support batch',
          },
        ],
      },
    });

  it('names the job-level reason when a whole batch is rejected', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    h.jobs.set('batch-1', rejected('batch-1', 'file-in-1'));

    const summary = await collectTask(h.deps, taskId);

    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual(['failed', 'failed']);
    expect(task.items[0].lastError).toMatch(
      /^batch failed: model_not_found The model does not support batch/,
    );
    expect(h.out.join('\n')).toMatch(/provider error: model_not_found/);
    expect(summary).toMatchObject({
      taskId,
      settled: 1,
      delivered: [],
      awaiting: 0,
      jobErrors: ['model_not_found The model does not support batch'],
    });
  });
});

describe('collectTask', () => {
  it('waits for a completed batch whose result file is not published yet', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    const job = h.jobs.get('batch-1') as BatchJob;
    job.status = 'completed'; // counts say 2 completed, but no output file yet

    await collectTask(h.deps, taskId);
    let task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'submitted',
      'submitted',
    ]);
    expect(task.attempts[0].collected).toBeUndefined();
    expect(h.out.join('\n')).toMatch(/result file is not available yet/);

    job.output_file_id = 'file-out-1';
    h.files.set(
      'file-out-1',
      `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    );
    await collectTask(h.deps, taskId);
    task = h.store.load(taskId);
    expect(task.items.every((item) => item.state === 'delivered')).toBe(true);
  });

  it('waits when a completed batch omits request_counts and has no result file', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    const job = h.jobs.get('batch-1') as BatchJob;
    job.status = 'completed';
    // A provider that omits the counts proves nothing about results:
    // failing every item here would invite a paid retry of billed work.
    delete job.request_counts;

    await collectTask(h.deps, taskId);
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'submitted',
      'submitted',
    ]);
    expect(task.attempts[0].collected).toBeUndefined();
    expect(h.out.join('\n')).toMatch(/result file is not available yet/);
  });

  it('still reports what it delivered when another batch of the task fails to collect', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    const task = h.store.load(taskId);
    // A second, still-open batch whose status query fails.
    task.attempts.push({
      attempt: 2,
      itemIds: [],
      submitState: 'created',
      batchId: 'batch-gone',
    });
    h.store.save(task);

    const error = (await collectTask(h.deps, taskId).catch(
      (e: unknown) => e,
    )) as Error & { summary?: { delivered: unknown[] } };
    expect(error.message).toMatch(/collect incomplete: batch-gone/);
    expect(error.summary?.delivered).toHaveLength(2);
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
    ).toBe('# A\n\nAlpha.');
  });

  it('reports a running batch and downloads nothing without --wait', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    await collectTask(h.deps, taskIdOf(h));
    expect(h.out.join('\n')).toMatch(/batch-1 is in_progress/);
    expect(h.api.downloadFile).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(h.root, 'docs', 'en', 'a.md'))).toBe(false);
  });

  it('delivers results, cleans up remote files, and is idempotent on re-run', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);

    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
    ).toBe('# A\n\nAlpha.');
    const task = h.store.load(taskId);
    expect(task.items.every((item) => item.state === 'delivered')).toBe(true);
    expect(task.attempts[0].usage).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      requests: 2,
      missing: 0,
    });
    // Remote input/output are deleted once results are safely local.
    const deleted = h.api.deleteFile.mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(deleted).toContain('file-in-1');
    expect(deleted).toContain('file-out-1');

    const downloads = h.api.downloadFile.mock.calls.length;
    const deletes = h.api.deleteFile.mock.calls.length;
    const polls = h.api.getBatch.mock.calls.length;
    const replay = await collectTask(h.deps, taskId); // re-collect: pure replay
    // Nothing new happened, so an auto-collect notice would be empty.
    expect(replay).toMatchObject({ settled: 0, delivered: [] });
    expect(h.api.downloadFile.mock.calls.length).toBe(downloads);
    expect(h.api.deleteFile.mock.calls.length).toBe(deletes);
    // A collected batch is never asked about again (the provider may have
    // forgotten it), and its billed usage survives the replay.
    expect(h.api.getBatch.mock.calls.length).toBe(polls);
    expect(h.store.load(taskId).attempts[0].usage).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      requests: 2,
      missing: 0,
    });
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'utf8'),
    ).toBe('# B\n\nBeta.');
  });

  it('retries remote cleanup on the next collect when a deletion fails', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    h.api.deleteFile.mockRejectedValueOnce(new Error('provider down'));
    await collectTask(h.deps, taskId);
    let task = h.store.load(taskId);
    expect(task.items.every((item) => item.state === 'delivered')).toBe(true);
    // A failed deletion leaves the attempt uncollected: marking it anyway
    // would leak the remote files forever.
    expect(task.attempts[0].collected).toBe(false);
    expect(h.err.join('\n')).toMatch(/could not delete remote file file-in-1/);

    const polls = h.api.getBatch.mock.calls.length;
    const downloads = h.api.downloadFile.mock.calls.length;
    const summary = await collectTask(h.deps, taskId);
    task = h.store.load(taskId);
    expect(task.attempts[0].collected).toBe(true);
    // The settled batch was re-fetched to retry cleanup, but results were
    // not re-downloaded or re-announced.
    expect(h.api.getBatch.mock.calls.length).toBe(polls + 1);
    expect(h.api.downloadFile.mock.calls.length).toBe(downloads);
    expect(summary.settled).toBe(0);
    expect(summary.delivered).toEqual([]);
    expect(
      h.api.deleteFile.mock.calls.map((call: unknown[]) => call[1]),
    ).toEqual(['file-in-1', 'file-out-1', 'file-in-1', 'file-out-1']);
  });

  it('marks per-item failures from bad statuses, the error file, and missing lines', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${JSON.stringify({ custom_id: 'a#1', response: { status_code: 500, body: { error: 'boom' } } })}\n`,
      error: `${JSON.stringify({ custom_id: 'b#1', error: { message: 'context length' } })}\n`,
    });
    // Add a third item that gets no result line at all: patch the task to
    // include it before collecting.
    const taskId = taskIdOf(h);
    const task = h.store.load(taskId);
    task.items.push({
      id: 'c',
      source: 'docs/zh/a.md',
      target: 'docs/en/c.md',
      state: 'submitted',
    });
    task.attempts[0].itemIds.push('c');
    h.store.save(task);

    await collectTask(h.deps, taskId);
    const collected = h.store.load(taskId);
    expect(collected.items.map((item) => item.state)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(collected.items[0].lastError).toMatch(/500/);
    expect(collected.items[1].lastError).toMatch(/context length/);
    expect(collected.items[2].lastError).toMatch(/no result line/);
    expect(h.out.join('\n')).toContain(`retry ${taskId}`);
  });

  it('ignores results whose custom_id is not part of this attempt', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('zzz#1', 'intruder')}\n${outputLine('a#2', 'wrong attempt')}\n${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('a#1', 'duplicate')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    await collectTask(h.deps, taskIdOf(h));
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
    ).toBe('# A\n\nAlpha.');
    expect(h.err.join('\n')).toMatch(/unknown custom_id/);
    expect(h.err.join('\n')).toMatch(/duplicate/);
  });

  it('holds on target conflict, then delivers once the user resolves it', async () => {
    const h = (harness = setup());
    fs.mkdirSync(path.join(h.root, 'docs', 'en'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'user edits');
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);

    let task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual(['delivered', 'held']);
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'utf8'),
    ).toBe('user edits');
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);

    // User resolves the conflict; re-collect delivers from the local record.
    fs.rmSync(path.join(h.root, 'docs', 'en', 'b.md'));
    await collectTask(h.deps, taskId);
    task = h.store.load(taskId);
    expect(task.items[1].state).toBe('delivered');
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'utf8'),
    ).toBe('# B\n\nBeta.');
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });

  it('keeps a retried item delivered when an earlier attempt is replayed', async () => {
    const h = (harness = setup());
    // Attempt 1: a fails with a provider error, b succeeds.
    await runAndSettle(h, {
      output: `${JSON.stringify({ custom_id: 'a#1', response: { status_code: 500, body: {} } })}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
      error: `${JSON.stringify({ custom_id: 'a#1', error: { message: 'boom' } })}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[0].state).toBe('failed');

    // Attempt 2 delivers a. The mock numbering makes this batch-2.
    await retryTask(h.deps, taskId);
    const job2 = h.jobs.get('batch-2');
    if (!job2) throw new Error('expected batch-2');
    job2.status = 'completed';
    job2.request_counts = { total: 1, completed: 1, failed: 0 };
    job2.output_file_id = 'file-out-2';
    h.files.set('file-out-2', `${outputLine('a#2', '# A\n\nAlpha.')}\n`);
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[0].state).toBe('delivered');

    // Re-collect replays attempt 1's recorded failure from disk; delivered
    // is terminal and must survive it.
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[0].state).toBe('delivered');
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
    ).toBe('# A\n\nAlpha.');
  });

  it('does not let an older attempt re-open an item a running retry owns', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${JSON.stringify({ custom_id: 'a#1', response: { status_code: 500, body: {} } })}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    await retryTask(h.deps, taskId); // batch-2, still in_progress

    // Collecting while attempt 2 runs replays attempt 1's failure for a.
    h.out.length = 0;
    await collectTask(h.deps, taskId);
    const task = h.store.load(taskId);
    expect(task.items[0]).toMatchObject({ state: 'submitted', lastAttempt: 2 });
    expect(h.out.join('\n')).not.toMatch(/qwen batch retry/);

    // Attempt 2 settles; a retry before collecting finds nothing to pay for.
    const job2 = h.jobs.get('batch-2');
    if (!job2) throw new Error('expected batch-2');
    job2.status = 'completed';
    job2.request_counts = { total: 1, completed: 1, failed: 0 };
    job2.output_file_id = 'file-out-2';
    h.files.set('file-out-2', `${outputLine('a#2', '# A\n\nAlpha.')}\n`);
    await retryTask(h.deps, taskId);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(2);

    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[0].state).toBe('delivered');
  });

  it('reconciles an attempt left in "uploaded" by a crash during create', async () => {
    const h = (harness = setup());
    h.files.set(
      'file-out-1',
      `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    );
    // The create lands provider-side, then the process dies before the
    // answer is recorded: the ledger still says `uploaded`, items pending.
    h.api.createBatch.mockImplementationOnce(
      async (_ep: unknown, inputFileId: string) => {
        h.jobs.set(
          'batch-lost',
          jobOf('batch-lost', 'completed', {
            input_file_id: inputFileId,
            output_file_id: 'file-out-1',
          }),
        );
        return new Promise<BatchJob>(() => undefined);
      },
    );
    void runPlan(h.deps, h.planPath);
    await vi.waitFor(() => expect(h.jobs.has('batch-lost')).toBe(true));
    const taskId = taskIdOf(h);
    expect(h.store.load(taskId).attempts[0].submitState).toBe('uploaded');
    // The "dead" process's lock would be stale; this test process is alive.
    fs.rmSync(path.join(path.dirname(h.store.fileOf(taskId)), 'lock'));
    h.out.length = 0;
    await listTasks(h.deps);
    expect(h.out.join('\n')).toMatch(/submit-unknown/);

    // A retry must not resubmit what may already be billing.
    await expect(retryTask(h.deps, taskId)).rejects.toThrow(/reconcile/);
    await collectTask(h.deps, taskId);
    const collected = h.store.load(taskId);
    expect(collected.attempts[0].batchId).toBe('batch-lost');
    expect(collected.items.map((item) => item.state)).toEqual([
      'delivered',
      'delivered',
    ]);
    expect(h.api.createBatch).toHaveBeenCalledTimes(1);
  });

  it('keeps a reconciled item submitted while its result is missing', async () => {
    const h = (harness = setup());
    h.files.set('file-out-1', `${outputLine('a#1', '# A\n\nAlpha.')}\n`);
    h.api.createBatch.mockImplementationOnce(
      async (_ep: unknown, inputFileId: string) => {
        h.jobs.set(
          'batch-lost',
          jobOf('batch-lost', 'completed', {
            input_file_id: inputFileId,
            output_file_id: 'file-out-1',
          }),
        );
        throw Object.assign(new Error('HTTP 502'), { status: 502 });
      },
    );
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(/reconcile/);
    const taskId = taskIdOf(h);
    await expect(collectTask(h.deps, taskId)).rejects.toThrow(
      /account for 1 of 2/,
    );
    const task = h.store.load(taskId);
    // b was never marked submitted before the fix and stayed pending forever.
    expect(task.items[1]).toMatchObject({ state: 'submitted', lastAttempt: 1 });
  });

  it('skips a malformed result line instead of blocking the whole task', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n{"custom_id":"b#1",\n`,
    });
    const taskId = taskIdOf(h);
    await expect(collectTask(h.deps, taskId)).rejects.toThrow(
      /account for 1 of 2/,
    );
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'delivered',
      'submitted',
    ]);
    expect(h.err.join('\n')).toMatch(/skipping output line 2/);
  });

  it('holds delivery when the source changed after submission', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    fs.writeFileSync(
      path.join(h.root, 'docs', 'zh', 'a.md'),
      '# A\n\n改过了。\n',
    );
    await collectTask(h.deps, taskIdOf(h));
    const task = h.store.load(taskIdOf(h));
    expect(task.items[0].state).toBe('held');
    expect(task.items[0].heldReason).toMatch(/changed/);
    expect(fs.existsSync(path.join(h.root, 'docs', 'en', 'a.md'))).toBe(false);
  });

  it('waits for a running batch with backoff when --wait is given', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const job = h.jobs.get('batch-1');
    if (!job) throw new Error('expected batch-1');
    let polls = 0;
    h.api.getBatch.mockImplementation(async () => {
      polls += 1;
      // Settle on the fourth poll of the wait loop, so the backoff sequence
      // shows three sleeps.
      if (polls >= 4) {
        job.status = 'completed';
        job.output_file_id = 'file-out-1';
        h.files.set(
          'file-out-1',
          `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
        );
      }
      return job;
    });
    await collectTask(h.deps, taskIdOf(h), { wait: true });
    expect(h.sleeps).toEqual([10_000, 20_000, 40_000]);
    expect(fs.existsSync(path.join(h.root, 'docs', 'en', 'a.md'))).toBe(true);
  });

  it('caps each backoff sleep at the remaining --timeout budget', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    let fakeNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    h.deps.sleep = async (ms) => {
      h.sleeps.push(ms);
      fakeNow += ms;
    };
    try {
      await expect(
        collectTask(h.deps, taskIdOf(h), { wait: true, timeoutSeconds: 15 }),
      ).rejects.toThrow(/still in_progress after the --wait timeout/);
    } finally {
      nowSpy.mockRestore();
    }
    // 10s then 20s of backoff, but only 15s of budget: the second sleep is
    // capped at the remaining 5s instead of overshooting the deadline.
    expect(h.sleeps).toEqual([10_000, 5_000]);
  });

  /** Settle `batch-1` on the third poll, refusing the second with `status`. */
  const pollsWithOneFailure = (h: Harness, status: number) => {
    const job = h.jobs.get('batch-1');
    if (!job) throw new Error('expected batch-1');
    let polls = 0;
    h.api.getBatch.mockImplementation(async () => {
      polls += 1;
      if (polls === 2) {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      }
      if (polls >= 3) {
        job.status = 'completed';
        job.output_file_id = 'file-out-1';
        h.files.set(
          'file-out-1',
          `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
        );
      }
      return job;
    });
  };

  it.each([503, 429, 408])(
    'keeps waiting through a transient HTTP %i while polling a status',
    async (status) => {
      const h = (harness = setup());
      await runPlan(h.deps, h.planPath);
      pollsWithOneFailure(h, status);
      // A wait can run for hours; one blip must not strand the batch.
      await collectTask(h.deps, taskIdOf(h), { wait: true });
      expect(h.err.join('\n')).toMatch(/warning: polling batch-1 failed/);
      expect(
        fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
      ).toBe('# A\n\nAlpha.');
    },
  );

  it('stops waiting at once on a definite client error', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    h.api.getBatch.mockRejectedValue(
      Object.assign(new Error('HTTP 401'), { status: 401 }),
    );
    await expect(
      collectTask(h.deps, taskIdOf(h), { wait: true }),
    ).rejects.toThrow(/HTTP 401/);
    // Retrying cannot fix a bad key, so the --timeout budget is not burned.
    expect(h.sleeps).toEqual([]);
  });
});

describe('retryTask', () => {
  it('resubmits only the failed items as a new attempt', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${JSON.stringify({ custom_id: 'b#1', response: { status_code: 500, body: {} } })}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);

    await retryTask(h.deps, taskId);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(2);
    const [, jsonl] = h.api.uploadJsonl.mock.calls[1];
    const ids = (jsonl as string)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).custom_id);
    expect(ids).toEqual(['b#2']);
    const task = h.store.load(taskId);
    expect(task.attempts).toHaveLength(2);
    expect(task.attempts[1]).toMatchObject({ attempt: 2, batchId: 'batch-2' });
  });

  it('refuses to retry while an earlier batch is still running', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const task = h.store.load(taskIdOf(h));
    task.items[0].state = 'failed';
    h.store.save(task);
    await expect(retryTask(h.deps, task.id)).rejects.toThrow(/still/);
  });

  it('refuses to retry while a submission is ambiguous', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const task = h.store.load(taskIdOf(h));
    task.attempts[0].submitState = 'unknown';
    task.items[0].state = 'failed';
    h.store.save(task);
    await expect(retryTask(h.deps, task.id)).rejects.toThrow(/reconcile/);
  });

  it('refuses to retry while a settled batch is still uncollected', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const task = h.store.load(taskIdOf(h));
    task.items[0].state = 'failed';
    h.store.save(task);
    await expect(retryTask(h.deps, task.id)).rejects.toThrow(/not collected/);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });

  it('applies the plan budget to retries too', async () => {
    const h = (harness = setup({ maxCostUsd: 5 }));
    h.deps.env = {
      ...h.deps.env,
      QWEN_BATCH_INPUT_PRICE_PER_1M_USD: '2',
      QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD: '6',
    };
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${JSON.stringify({ custom_id: 'b#1', response: { status_code: 500, body: {} } })}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    h.deps.env = { QWEN_BATCH_HOME: h.home }; // prices gone
    await expect(retryTask(h.deps, taskId)).rejects.toThrow(
      /cannot be enforced/,
    );
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });

  it('gates the retry on the real assembly, not the run-time average', async () => {
    const h = (harness = setup({ maxCostUsd: 0.01 }));
    h.deps.env = {
      ...h.deps.env,
      QWEN_BATCH_INPUT_PRICE_PER_1M_USD: '2',
      QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD: '6',
    };
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${JSON.stringify({ custom_id: 'b#1', response: { status_code: 500, body: {} } })}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    // b's source grows massively after the run: the run's per-item average
    // stays tiny, but the request actually being submitted is what the
    // budget must judge.
    fs.writeFileSync(
      path.join(h.root, 'docs', 'zh', 'b.md'),
      'y'.repeat(30000),
    );
    await expect(retryTask(h.deps, taskId)).rejects.toThrow(/exceeds the plan/);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });

  it('skips truncated items unless a larger output limit is given', async () => {
    const h = (harness = setup({ maxOutputTokens: 1000 }));
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${truncatedLine('b#1')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[1]).toMatchObject({
      state: 'failed',
      truncated: true,
    });

    // Same limit would fail the same way and bill again: nothing is sent.
    await retryTask(h.deps, taskId);
    expect(h.out.join('\n')).toMatch(/skipping 1 truncated item/);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);

    await expect(
      retryTask(h.deps, taskId, { maxOutputTokens: 1000 }),
    ).rejects.toThrow(/truncated at 1000/);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);

    await retryTask(h.deps, taskId, { maxOutputTokens: 4000 });
    expect(uploadedBodies(h, 2)).toEqual([
      expect.objectContaining({ max_tokens: 4000 }),
    ]);
    expect(h.store.load(taskId).attempts[1].maxOutputTokens).toBe(4000);
  });

  it('reports when nothing is retryable', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    await retryTask(h.deps, taskIdOf(h));
    expect(h.out.join('\n')).toMatch(/nothing to retry/);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });
});

describe('frozen request parameters', () => {
  it('runs with the realtime settings and retries reuse them after the config changes', async () => {
    const h = (harness = setup());
    h.deps.ep = {
      ...h.deps.ep,
      generationConfig: {
        samplingParams: { temperature: 0.2 },
        extra_body: { enable_thinking: true },
      },
    };
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${JSON.stringify({ custom_id: 'b#1', response: { status_code: 500, body: {} } })}\n`,
    });
    expect(uploadedBodies(h, 1)[0]).toMatchObject({
      temperature: 0.2,
      enable_thinking: true,
    });
    expect(h.out.join('\n')).toMatch(/model qwen-plus, thinking on/);

    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    h.deps.ep = { ...h.deps.ep, generationConfig: { reasoning: false } };
    await retryTask(h.deps, taskId);
    expect(uploadedBodies(h, 2)[0]).toMatchObject({
      temperature: 0.2,
      enable_thinking: true,
    });
  });

  it('refuses a plan that disables thinking on a thinking-mandatory model', async () => {
    const h = (harness = setup({ enableThinking: false }));
    h.deps.ep = {
      ...h.deps.ep,
      generationConfig: { thinkingMandatory: true },
    };
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(
      /requires thinking/,
    );
    expect(h.api.uploadJsonl).not.toHaveBeenCalled();
    expect(h.store.list()).toHaveLength(0);
  });
});

describe('usage and cost reporting', () => {
  it('marks usage incomplete instead of counting a missing usage as zero', async () => {
    const noUsage = JSON.stringify({
      custom_id: 'b#1',
      response: {
        status_code: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: '# B\n\nBeta.' },
            },
          ],
        },
      },
    });
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${noUsage}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).attempts[0].usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      requests: 2,
      missing: 1,
    });
    expect(h.out.join('\n')).toMatch(
      /INCOMPLETE: 1 request\(s\) reported no usage/,
    );
  });

  it('keeps the billed usage of a collected attempt whose local copy is gone', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    const billed = {
      promptTokens: 200,
      completionTokens: 100,
      requests: 2,
      missing: 0,
    };
    expect(h.store.load(taskId).attempts[0].usage).toEqual(billed);

    // Disk cleanup, or a batch-home migration that copied task.json but not
    // the attempt dirs. The remote files were deleted at the first collect,
    // so this pass is neither offered nor able to read any result line —
    // recomputing from nothing must not erase the only record of the bill.
    fs.rmSync(path.join(h.store.attemptDir(taskId, 1), 'output.jsonl'));
    h.out.length = 0;
    const calls = h.api.getBatch.mock.calls.length;

    await collectTask(h.deps, taskId);

    expect(h.api.getBatch.mock.calls.length).toBe(calls);
    expect(h.store.load(taskId).attempts[0].usage).toEqual(billed);
    expect(h.out.join('\n')).toMatch(/Batch usage, all attempts/);
  });
});

describe('cleanTask', () => {
  it('refuses while a batch may still be running, and removes it when forced', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    await expect(cleanTask(h.deps, taskId)).rejects.toThrow(/batch-1/);
    expect(fs.existsSync(h.store.fileOf(taskId))).toBe(true);
    await cleanTask(h.deps, taskId, { force: true });
    expect(fs.existsSync(h.store.fileOf(taskId))).toBe(false);
    expect(h.err.join('\n')).toMatch(/batch-1 was not cancelled/);
    expect(h.api.cancelBatch).not.toHaveBeenCalled();
  });

  it('removes a collected task without touching the provider', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    const calls = h.api.getBatch.mock.calls.length;
    await cleanTask(h.deps, taskId);
    expect(h.store.list()).toHaveLength(0);
    expect(h.api.getBatch.mock.calls.length).toBe(calls);
    // Delivered files are the user's; clean never touches them.
    expect(fs.existsSync(path.join(h.root, 'docs', 'en', 'a.md'))).toBe(true);
  });

  it('refuses to delete the only copy of a held result unless forced', async () => {
    const h = (harness = setup());
    fs.mkdirSync(path.join(h.root, 'docs', 'en'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'user edits');
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[1].state).toBe('held');

    // The remote files are deleted at collect, so the record is the only
    // copy of the held, already-billed generation.
    await expect(cleanTask(h.deps, taskId)).rejects.toThrow(/undelivered/);
    expect(fs.existsSync(h.store.fileOf(taskId))).toBe(true);

    await cleanTask(h.deps, taskId, { force: true });
    expect(fs.existsSync(h.store.fileOf(taskId))).toBe(false);
  });

  it('says a forced clean destroyed held results, as it says for an uncancelled batch', async () => {
    const h = (harness = setup());
    fs.mkdirSync(path.join(h.root, 'docs', 'en'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'user edits');
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[1].state).toBe('held');
    // A retry leaves a second, uncollected attempt, so the refusal the user
    // meets first is the open-batch one — and its own text ends "or pass
    // --force". Re-running with --force then skips the held check entirely,
    // which is how a paid generation is destroyed without ever being named.
    const task = h.store.load(taskId);
    task.attempts.push({
      attempt: 2,
      itemIds: [],
      submitState: 'created',
      batchId: 'batch-2',
    });
    h.store.save(task);

    await expect(cleanTask(h.deps, taskId)).rejects.toThrow(/batch-2/);
    await cleanTask(h.deps, taskId, { force: true });
    expect(fs.existsSync(h.store.fileOf(taskId))).toBe(false);
    const warned = h.err.join('\n');
    expect(warned).toMatch(/batch-2 was not cancelled/);
    expect(warned).toMatch(/1 undelivered result\(s\) \(b\)/);
    expect(warned).toMatch(/only copy/);
  });
});

describe('endpoint identity', () => {
  it('refuses to act on a task from another endpoint or account', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    const task = h.store.load(taskId);
    expect(task.endpoint?.baseUrl).toBe('http://fake');
    // Only a short hash is kept, never the key.
    expect(JSON.stringify(task)).not.toContain('"k"');
    const calls = h.api.getBatch.mock.calls.length;

    const otherRegion = {
      ...h.deps,
      ep: { ...h.deps.ep, baseUrl: 'http://other' },
    };
    await expect(collectTask(otherRegion, taskId)).rejects.toThrow(
      /submitted to http:\/\/fake/,
    );
    const otherKey = { ...h.deps, ep: { ...h.deps.ep, apiKey: 'k2' } };
    await expect(retryTask(otherKey, taskId)).rejects.toThrow(
      /different API key/,
    );
    await expect(cancelTask(otherKey, taskId)).rejects.toThrow(
      /different API key/,
    );
    expect(h.api.getBatch.mock.calls.length).toBe(calls);
  });
});

describe('checkReadiness', () => {
  it('probes the Batch route and shows what a run would freeze', async () => {
    const h = (harness = setup());
    const probe = vi.fn(async () => undefined);
    h.deps.api = { ...h.api, probe };
    h.deps.ep = {
      ...h.deps.ep,
      generationConfig: { samplingParams: { max_tokens: 2048 } },
    };
    await checkReadiness(h.deps);
    expect(probe).toHaveBeenCalledWith(h.deps.ep);
    const text = h.out.join('\n');
    expect(text).toMatch(/ready: fake accepts Batch requests/);
    expect(text).toMatch(/thinking: provider default, max output 2048 tokens/);
    expect(text).toMatch(/no unit prices/);
  });

  it('fails before any preparation when the route is unusable', async () => {
    const h = (harness = setup());
    h.deps.api = {
      ...h.api,
      probe: async () => {
        throw new Error('GET /batches?limit=1 -> HTTP 401: invalid key');
      },
    };
    await expect(checkReadiness(h.deps)).rejects.toThrow(/401/);
    expect(h.out).toEqual([]);
  });
});

describe('cancelTask', () => {
  it('cancels the active batch and warns about billed partials', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    await cancelTask(h.deps, taskIdOf(h));
    expect(h.api.cancelBatch).toHaveBeenCalledWith(h.deps.ep, 'batch-1');
    expect(h.out.join('\n')).toMatch(/still billed/);
  });

  it('points a settled batch at collect instead', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    await cancelTask(h.deps, taskIdOf(h));
    expect(h.api.cancelBatch).not.toHaveBeenCalled();
    expect(h.out.join('\n')).toMatch(/already settled/);
  });

  it('refuses when the task never reached the provider', async () => {
    const h = (harness = setup());
    const task = h.store.create(
      JSON.parse(fs.readFileSync(h.planPath, 'utf8')),
      h.root,
      'qwen-plus',
    );
    await expect(cancelTask(h.deps, task.id)).rejects.toThrow(
      /no submitted batch/,
    );
  });

  it('refuses while an ambiguous submission may exist and be billing', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    // A retry whose create answer never arrived: the batch may exist.
    const task = h.store.load(taskId);
    task.attempts.push({
      attempt: 2,
      itemIds: ['b'],
      submitState: 'unknown',
      inputFileId: 'file-in-2',
    });
    h.store.save(task);

    await expect(cancelTask(h.deps, taskId)).rejects.toThrow(/reconcile/);
    expect(h.api.cancelBatch).not.toHaveBeenCalled();
    expect(h.out.join('\n')).not.toMatch(/already settled/);
  });
});

describe('listTasks', () => {
  it('prints recorded tasks with their delivery progress', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    h.out.length = 0; // ignore runPlan's own report
    await listTasks(h.deps);
    const lines = h.out.filter((line) => line.includes('translate-test-'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('0/2 delivered');
    expect(lines[0]).toContain('batch batch-1');
    // Records are per user, so each row names its project.
    expect(lines[0]).toContain(h.root);
  });

  it('says so when there are no tasks', async () => {
    const h = (harness = setup());
    await listTasks(h.deps);
    expect(h.out.join('\n')).toMatch(/no batch tasks/);
  });
});

describe('review fixes', () => {
  it('treats an already-deleted remote file as cleaned up', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    h.api.deleteFile.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 404'), { status: 404 }),
    );
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).attempts[0].collected).toBe(true);
  });

  it('holds no task lock while --wait polls, so cancel still works', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    let cancelled = false;
    h.deps.sleep = async () => {
      if (cancelled) return;
      cancelled = true;
      await cancelTask(h.deps, taskId); // lockWaitMs is 0: a held lock throws
    };
    await collectTask(h.deps, taskId, { wait: true });
    expect(h.api.cancelBatch).toHaveBeenCalledWith(h.deps.ep, 'batch-1');
  });

  it('waits for the partial results of a cancelled batch instead of failing every item', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    const job = h.jobs.get('batch-1') as BatchJob;
    job.status = 'cancelled'; // 2 requests finished, output not attached yet
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'submitted',
      'submitted',
    ]);
    expect(task.attempts[0].collected).toBeFalsy();
    expect(h.out.join('\n')).toMatch(
      /cancelled but its result file is not available yet/,
    );
  });

  it('lets retry resubmit an item held because its source changed', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    fs.writeFileSync(
      path.join(h.root, 'docs', 'zh', 'a.md'),
      '# A\n\n改过了。\n',
    );
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[0]).toMatchObject({
      state: 'held',
      sourceChanged: true,
    });
    await retryTask(h.deps, taskId);
    const task = h.store.load(taskId);
    expect(task.attempts[1].itemIds).toEqual(['a']);
    expect(task.items[0]).toMatchObject({ state: 'submitted', lastAttempt: 2 });
    expect(task.items[0].sourceChanged).toBeUndefined();
  });

  it('refuses to retry, and bills nothing, while another process holds the task lock', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${JSON.stringify({ custom_id: 'a#1', response: { status_code: 500, body: {} } })}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    fs.writeFileSync(
      path.join(path.dirname(h.store.fileOf(taskId)), 'lock'),
      `${process.pid}\n${os.hostname()}\nx\n`,
    );
    await expect(retryTask(h.deps, taskId)).rejects.toThrow(
      /in use by another/,
    );
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });

  it('keeps remote files and fails nothing when no result line can be matched', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('zzz#1', 'a format we could not map')}\n`,
    });
    const taskId = taskIdOf(h);
    await expect(collectTask(h.deps, taskId)).rejects.toThrow(
      /account for 0 of 2/,
    );
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'submitted',
      'submitted',
    ]);
    expect(task.attempts[0].collected).toBeFalsy();
    expect(task.attempts[0].outputPath).toBeUndefined();
    expect(h.api.deleteFile).not.toHaveBeenCalled();
  });

  it('treats a create answer without a batch id as ambiguous', async () => {
    const h = (harness = setup());
    h.api.createBatch.mockImplementationOnce(async () => ({}) as BatchJob);
    await expect(runPlan(h.deps, h.planPath)).rejects.toThrow(/reconcile/);
    const task = h.store.load(taskIdOf(h));
    expect(task.attempts[0].submitState).toBe('unknown');
    expect(task.attempts[0].batchId).toBeUndefined();
  });

  it('holds an item whose target cannot be written and still delivers the rest', async () => {
    const h = (harness = setup());
    // The target path is a directory: reading or writing it throws.
    fs.mkdirSync(path.join(h.root, 'docs', 'en', 'a.md'), { recursive: true });
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual(['held', 'delivered']);
    expect(task.items[0].heldReason).toMatch(/cannot write target/);
  });

  it('creates the batch with the plan completion window', async () => {
    const h = (harness = setup({ completionWindow: '7d' }));
    await runPlan(h.deps, h.planPath);
    expect(h.api.createBatch).toHaveBeenCalledWith(
      h.deps.ep,
      'file-in-1',
      '7d',
    );
  });

  it('downloads a result file again when its recorded local copy is gone', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    const task = h.store.load(taskId);
    task.attempts[0].outputPath = path.join(h.home, 'gone', 'output.jsonl');
    h.store.save(task);
    await collectTask(h.deps, taskId);
    expect(h.api.downloadFile).toHaveBeenCalled();
    expect(h.store.load(taskId).items.map((item) => item.state)).toEqual([
      'delivered',
      'delivered',
    ]);
  });

  it('previews without uploading or leaving a task, then submits that exact snapshot', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath, { dryRun: true });
    expect(h.api.uploadJsonl).not.toHaveBeenCalled();
    expect(h.store.list()).toEqual([]);
    const digest = /--expect ([0-9a-f]{16})/.exec(h.out.join('\n'))?.[1];
    expect(digest).toBeDefined();

    await runPlan(h.deps, h.planPath, { expect: digest });
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
    expect(h.store.list()).toHaveLength(1);
  });

  it('refuses a submission whose batch changed after the approved preview', async () => {
    const mutations: Array<(plan: Record<string, unknown>) => void> = [
      (plan) => {
        (plan['shared'] as Record<string, unknown>)['instructions'] =
          'Translate to French.';
      },
      (plan) => {
        plan['items'] = (plan['items'] as unknown[]).slice(0, 1);
      },
      (plan) => {
        plan['maxOutputTokens'] = 64;
      },
      (plan) => {
        (plan['items'] as Array<Record<string, unknown>>)[0]['target'] =
          'docs/en/elsewhere.md';
      },
    ];
    for (const mutate of mutations) {
      const h = (harness = setup());
      await runPlan(h.deps, h.planPath, { dryRun: true });
      const digest = /--expect ([0-9a-f]{16})/.exec(h.out.join('\n'))?.[1];
      const plan = JSON.parse(fs.readFileSync(h.planPath, 'utf8'));
      mutate(plan);
      fs.writeFileSync(h.planPath, JSON.stringify(plan));
      await expect(
        runPlan(h.deps, h.planPath, { expect: digest }),
      ).rejects.toThrow(/changed since it was previewed/);
      expect(h.api.uploadJsonl).not.toHaveBeenCalled();
      expect(h.store.list()).toEqual([]);
      fs.rmSync(h.root, { recursive: true, force: true });
      fs.rmSync(h.home, { recursive: true, force: true });
    }
    harness = undefined;
  });

  it('refuses a submission whose source file changed after the preview', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath, { dryRun: true });
    const digest = /--expect ([0-9a-f]{16})/.exec(h.out.join('\n'))?.[1];
    fs.writeFileSync(
      path.join(h.root, 'docs', 'zh', 'a.md'),
      '# A\n\n改了。\n',
    );
    await expect(
      runPlan(h.deps, h.planPath, { expect: digest }),
    ).rejects.toThrow(/changed since it was previewed/);
    expect(h.api.uploadJsonl).not.toHaveBeenCalled();
  });

  it('counts a batch as settled by the pass that finishes its harvest', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
      error: `${JSON.stringify({ custom_id: 'zzz#1', error: { message: 'unrelated' } })}\n`,
    });
    const taskId = taskIdOf(h);
    // The first pass downloads the output file and then dies fetching the
    // error file: the harvest never completes.
    const download = h.api.downloadFile.getMockImplementation();
    if (!download) throw new Error('expected a download implementation');
    h.api.downloadFile
      .mockImplementationOnce(download)
      .mockRejectedValueOnce(new Error('network down'));
    await expect(collectTask(h.deps, taskId)).rejects.toThrow(/network down/);

    // The completing pass must still count as the first harvest, or the
    // auto-collector's notice gate never reports this batch settling.
    const summary = await collectTask(h.deps, taskId);
    expect(summary.settled).toBe(1);
    const task = h.store.load(taskId);
    expect(task.attempts[0].finalStatus).toBe('completed');
    expect(task.attempts[0].collected).toBe(true);
  });

  it('delivers from the local record when the provider cannot be reached for cleanup', async () => {
    const h = (harness = setup());
    fs.mkdirSync(path.join(h.root, 'docs', 'en'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'user edits');
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    // The harvest succeeds but a remote deletion fails, leaving the attempt
    // uncollected with the results on disk.
    h.api.deleteFile.mockRejectedValueOnce(new Error('provider down'));
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[1].state).toBe('held');

    // The user resolves the conflict; the next pass cannot reach the batch.
    fs.rmSync(path.join(h.root, 'docs', 'en', 'b.md'));
    h.api.getBatch.mockRejectedValueOnce(
      Object.assign(new Error('HTTP 429'), { status: 429 }),
    );
    const summary = await collectTask(h.deps, taskId);
    expect(summary.delivered.map((item) => item.id)).toEqual(['b']);
    const task = h.store.load(taskId);
    expect(task.items[1].state).toBe('delivered');
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'utf8'),
    ).toBe('# B\n\nBeta.');
    // The cleanup retry is not lost: the attempt stays uncollected.
    expect(task.attempts[0].collected).toBe(false);
    expect(h.err.join('\n')).toMatch(/cannot re-fetch batch-1/);
  });

  it('re-downloads incomplete results without failing or resubmitting missing items', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n`,
    });
    const taskId = taskIdOf(h);
    await expect(collectTask(h.deps, taskId)).rejects.toThrow(
      /account for 1 of 2/,
    );
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'delivered',
      'submitted',
    ]);
    expect(h.api.deleteFile).not.toHaveBeenCalled();
    expect(task.attempts[0].collected).toBeFalsy();
    expect(task.attempts[0].outputPath).toBeUndefined();
    expect(task.attempts[0].finalStatus).toBeUndefined();

    const outputId = h.jobs.get(task.attempts[0].batchId!)!.output_file_id!;
    h.files.set(
      outputId,
      `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    );
    const summary = await collectTask(h.deps, taskId);
    expect(summary.delivered.map((item) => item.id)).toEqual(['b']);
    expect(summary.settled).toBe(1);
    expect(h.api.downloadFile).toHaveBeenCalledTimes(2);
    expect(h.api.createBatch).toHaveBeenCalledTimes(1);
    expect(h.store.load(taskId).attempts[0]).toMatchObject({
      collected: true,
      usage: { requests: 2, promptTokens: 200, completionTokens: 100 },
    });
  });

  it('does not move the source baseline when a retry dies before its create lands', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n${outputLine('b#1', '# B\n\nBeta.')}\n`,
    });
    const taskId = taskIdOf(h);
    fs.writeFileSync(
      path.join(h.root, 'docs', 'zh', 'a.md'),
      '# A\n\n改过了。\n',
    );
    await collectTask(h.deps, taskId);
    expect(h.store.load(taskId).items[0]).toMatchObject({
      state: 'held',
      sourceChanged: true,
    });

    // The retry's upload never lands: no batch exists, so its re-read
    // source hash must not become the baseline collect compares against.
    h.api.uploadJsonl.mockRejectedValueOnce(new Error('network down'));
    await expect(retryTask(h.deps, taskId)).rejects.toThrow(/network down/);

    await collectTask(h.deps, taskId);
    const item = h.store.load(taskId).items[0];
    expect(item).toMatchObject({ state: 'held', sourceChanged: true });
    expect(fs.existsSync(path.join(h.root, 'docs', 'en', 'a.md'))).toBe(false);
  });
});
