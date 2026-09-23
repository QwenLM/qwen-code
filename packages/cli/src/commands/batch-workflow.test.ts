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

    await runPlan(h.deps, h.planPath); // must not throw
    const task = h.store.load(taskIdOf(h));
    expect(task.status).toBe('submit-unknown');
    expect(h.err.join('\n')).toMatch(/may exist and be billing/);

    await collectTask(h.deps, task.id);
    expect(h.api.createBatch).toHaveBeenCalledTimes(1); // never resubmitted
    const reconciled = h.store.load(task.id);
    expect(reconciled.attempts[0].batchId).toBe('batch-lost');
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'a.md'), 'utf8'),
    ).toBe('# A\n\nAlpha.');
  });
});

describe('collectTask', () => {
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
    await collectTask(h.deps, taskId); // re-collect: pure replay
    expect(h.api.downloadFile.mock.calls.length).toBe(downloads);
    expect(h.api.deleteFile.mock.calls.length).toBe(deletes);
    // A collected batch is never asked about again (the provider may have
    // forgotten it), and its billed usage survives the replay.
    expect(h.api.getBatch.mock.calls.length).toBe(polls);
    expect(h.store.load(taskId).attempts[0].usage).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      requests: 2,
    });
    expect(
      fs.readFileSync(path.join(h.root, 'docs', 'en', 'b.md'), 'utf8'),
    ).toBe('# B\n\nBeta.');
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

  it('fails an item whose line is missing after a reconcile', async () => {
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
    await runPlan(h.deps, h.planPath);
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    const task = h.store.load(taskId);
    // b was never marked submitted before the fix and stayed pending forever.
    expect(task.items[1]).toMatchObject({ state: 'failed' });
    expect(task.items[1].lastError).toMatch(/no result line/);
  });

  it('skips a malformed result line instead of blocking the whole task', async () => {
    const h = (harness = setup());
    await runAndSettle(h, {
      output: `${outputLine('a#1', '# A\n\nAlpha.')}\n{"custom_id":"b#1",\n`,
    });
    const taskId = taskIdOf(h);
    await collectTask(h.deps, taskId);
    const task = h.store.load(taskId);
    expect(task.items.map((item) => item.state)).toEqual([
      'delivered',
      'failed',
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
      // collectTask checks once before entering the wait loop; settle on
      // the third loop poll so the backoff sequence shows two sleeps.
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
    expect(h.sleeps).toEqual([10_000, 20_000]);
    expect(fs.existsSync(path.join(h.root, 'docs', 'en', 'a.md'))).toBe(true);
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

  it('reports when nothing is retryable', async () => {
    const h = (harness = setup());
    await runPlan(h.deps, h.planPath);
    await retryTask(h.deps, taskIdOf(h));
    expect(h.out.join('\n')).toMatch(/nothing to retry/);
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
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
  });

  it('says so when there are no tasks', async () => {
    const h = (harness = setup());
    await listTasks(h.deps);
    expect(h.out.join('\n')).toMatch(/no batch tasks/);
  });
});
