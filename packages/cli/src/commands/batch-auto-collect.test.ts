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
  createBatchAutoCollector,
  describeCollect,
  type BatchAutoCollectMode,
} from './batch-auto-collect.js';
import {
  runPlan,
  type WorkflowApi,
  type WorkflowDeps,
} from './batch-workflow.js';
import { BatchTaskStore } from './batch-task.js';
import type { BatchEndpoint, BatchJob } from './batch.js';

const outputLine = (customId: string, content: string) =>
  JSON.stringify({
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    },
  });

interface Harness {
  root: string;
  home: string;
  ep: BatchEndpoint;
  env: Record<string, string>;
  jobs: Map<string, BatchJob>;
  files: Map<string, string>;
  api: WorkflowApi & { getBatch: ReturnType<typeof vi.fn> };
  notices: string[];
  clock: { now: number };
}

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    fs.rmSync(h.root, { recursive: true, force: true });
    fs.rmSync(h.home, { recursive: true, force: true });
  }
});

function setup(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-ac-project-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-ac-home-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.md'), '# A\n');
  fs.writeFileSync(path.join(root, 'src', 'b.md'), '# B\n');
  fs.writeFileSync(
    path.join(root, 'plan.json'),
    JSON.stringify({
      version: 1,
      name: 'ac',
      kind: 'document-transform',
      shared: { instructions: 'Translate.' },
      items: [
        { id: 'a', source: 'src/a.md', target: 'out/a.md' },
        { id: 'b', source: 'src/b.md', target: 'out/b.md' },
      ],
    }),
  );
  const jobs = new Map<string, BatchJob>();
  const files = new Map<string, string>();
  const api = {
    uploadJsonl: vi.fn(async () => ({ id: `file-in-${files.size + 1}` })),
    createBatch: vi.fn(async (_ep: unknown, inputFileId: string) => {
      const job: BatchJob = {
        id: `batch-${jobs.size + 1}`,
        status: 'in_progress',
        created_at: 1,
        input_file_id: inputFileId,
      };
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
        fs.writeFileSync(target, files.get(fileId) ?? '');
      },
    ),
    deleteFile: vi.fn(async () => undefined),
    cancelBatch: vi.fn(async () => {
      throw new Error('unused');
    }),
  };
  const h: Harness = {
    root,
    home,
    ep: { apiKey: 'k', baseUrl: 'http://fake', model: 'qwen-plus' },
    env: { QWEN_BATCH_HOME: home },
    jobs,
    files,
    api,
    notices: [],
    clock: { now: 1_000_000 },
  };
  harnesses.push(h);
  return h;
}

async function submit(h: Harness) {
  const deps: WorkflowDeps = {
    ep: h.ep,
    cwd: h.root,
    env: h.env,
    out: () => {},
    err: () => {},
    api: h.api,
    sleep: async () => {},
  };
  await runPlan(deps, 'plan.json');
  return new BatchTaskStore(h.home).list()[0].id;
}

function settle(h: Harness, output: string) {
  const job = h.jobs.get('batch-1') as BatchJob;
  job.status = 'completed';
  job.output_file_id = 'file-out-1';
  h.files.set('file-out-1', output);
}

function collector(
  h: Harness,
  mode: BatchAutoCollectMode = 'deliver',
  overrides: Partial<Parameters<typeof createBatchAutoCollector>[0]> = {},
) {
  return createBatchAutoCollector({
    projectRoot: h.root,
    mode,
    notify: (message) => h.notices.push(message),
    resolveEndpoint: () => h.ep,
    env: h.env,
    api: h.api,
    now: () => h.clock.now,
    ...overrides,
  });
}

describe('batch auto-collect', () => {
  it('delivers a finished batch once and then stops asking the provider', async () => {
    const h = setup();
    const taskId = await submit(h);
    const ac = collector(h);

    await ac.tick(); // still running: nothing to say
    expect(h.notices).toEqual([]);
    expect(fs.existsSync(path.join(h.root, 'out', 'a.md'))).toBe(false);

    settle(h, `${outputLine('a#1', '# 甲')}\n${outputLine('b#1', '# 乙')}\n`);
    await ac.tick(); // backed off: not due yet
    expect(h.notices).toEqual([]);

    h.clock.now += 10 * 60_000;
    await ac.tick();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(
      new RegExp(`Batch task ${taskId}: 2 result\\(s\\) delivered`),
    );
    expect(fs.readFileSync(path.join(h.root, 'out', 'a.md'), 'utf8')).toBe(
      '# 甲',
    );

    const polls = h.api.getBatch.mock.calls.length;
    h.clock.now += 10 * 60_000;
    await ac.tick();
    expect(h.notices).toHaveLength(1);
    expect(h.api.getBatch.mock.calls.length).toBe(polls);
  });

  it('collects at startup a task that finished while no session was open', async () => {
    const h = setup();
    await submit(h);
    settle(h, `${outputLine('a#1', '# 甲')}\n${outputLine('b#1', '# 乙')}\n`);
    await collector(h).tick();
    expect(h.notices).toHaveLength(1);
    expect(fs.existsSync(path.join(h.root, 'out', 'b.md'))).toBe(true);
  });

  it('names failures and how to retry, without retrying', async () => {
    const h = setup();
    const taskId = await submit(h);
    settle(
      h,
      `${outputLine('a#1', '# 甲')}\n${JSON.stringify({ custom_id: 'b#1', response: { status_code: 500, body: {} } })}\n`,
    );
    await collector(h).tick();
    expect(h.notices[0]).toMatch(/1 result\(s\) delivered/);
    expect(h.notices[0]).toMatch(
      new RegExp(`1 failed .*qwen batch retry ${taskId}`),
    );
    expect(h.api.uploadJsonl).toHaveBeenCalledTimes(1);
  });

  it('in notify mode says the task is ready once and writes nothing', async () => {
    const h = setup();
    const taskId = await submit(h);
    settle(h, `${outputLine('a#1', '# 甲')}\n`);
    const ac = collector(h, 'notify');
    await ac.tick();
    h.clock.now += 10 * 60_000;
    await ac.tick();
    expect(h.notices).toEqual([
      `Batch task ${taskId} has finished on the provider. Collect it with: qwen batch collect ${taskId}`,
    ]);
    expect(fs.existsSync(path.join(h.root, 'out'))).toBe(false);
  });

  it('ignores tasks of other projects', async () => {
    const h = setup();
    await submit(h);
    settle(h, `${outputLine('a#1', '# 甲')}\n`);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-ac-other-'));
    try {
      await collector(h, 'deliver', { projectRoot: other }).tick();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
    expect(h.notices).toEqual([]);
    expect(h.api.getBatch).not.toHaveBeenCalled();
  });

  it('leaves a task pinned to another key alone instead of retrying it', async () => {
    const h = setup();
    await submit(h);
    settle(h, `${outputLine('a#1', '# 甲')}\n`);
    const log = vi.fn();
    const ac = collector(h, 'deliver', {
      resolveEndpoint: () => ({ ...h.ep, apiKey: 'other-key' }),
      log,
    });
    await ac.tick();
    h.clock.now += 10 * 60_000;
    await ac.tick();
    expect(h.notices).toEqual([]);
    expect(h.api.getBatch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('stays quiet and offline without usable Batch credentials', async () => {
    const h = setup();
    await submit(h);
    const ac = collector(h, 'deliver', {
      resolveEndpoint: () => {
        throw new Error('qwen batch needs an API key');
      },
    });
    await ac.tick();
    await ac.tick();
    expect(h.notices).toEqual([]);
    expect(h.api.getBatch).not.toHaveBeenCalled();
  });

  it('does nothing when there is no open task', async () => {
    const h = setup();
    const resolveEndpoint = vi.fn(() => h.ep);
    const delay = await collector(h, 'deliver', { resolveEndpoint }).tick();
    expect(delay).toBe(60_000);
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });
});

describe('describeCollect', () => {
  it('says nothing when a collect changed nothing', () => {
    expect(
      describeCollect({
        taskId: 't',
        settled: 0,
        delivered: [],
        held: [],
        failed: [],
        awaiting: 2,
        jobErrors: [],
      }),
    ).toBeUndefined();
  });

  it('names the provider error of a batch rejected as a whole', () => {
    const failed = {
      id: 'a',
      source: 's',
      target: 't',
      state: 'failed' as const,
      lastError: 'batch failed: model_not_found',
    };
    const text = describeCollect({
      taskId: 't',
      settled: 1,
      delivered: [],
      held: [],
      failed: [failed],
      awaiting: 0,
      jobErrors: ['model_not_found The model does not support batch'],
    });
    expect(text).toMatch(/0 result\(s\) delivered; 1 failed/);
    expect(text).toMatch(/provider: model_not_found/);
  });
});
