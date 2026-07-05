/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Request } from 'express';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Storage } from '@qwen-code/qwen-code-core';
import { registerScheduledTasksRoutes } from './scheduled-tasks.js';

function safeBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

interface Harness {
  app: express.Application;
  scratch: string;
  workspace: string;
}

async function makeHarness(): Promise<Harness> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sched-route-'));
  const workspace = path.join(scratch, 'workspace');
  await fsp.mkdir(workspace, { recursive: true });
  // The durable tasks file lands under the runtime base dir, not the real
  // ~/.qwen — redirect it into the scratch dir for the duration of the test.
  Storage.setRuntimeBaseDir(scratch);

  const app = express();
  app.use(express.json());
  registerScheduledTasksRoutes(app, {
    boundWorkspace: workspace,
    // Non-strict mutate is a passthrough (matches the loopback web-shell).
    mutate: () => (_req, _res, next) => next(),
    safeBody,
  });
  return { app, scratch, workspace };
}

async function teardown(h: Harness): Promise<void> {
  Storage.setRuntimeBaseDir(null);
  await fsp.rm(h.scratch, { recursive: true, force: true });
}

describe('scheduled-tasks routes', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  const create = (body: Record<string, unknown>) =>
    request(h.app).post('/scheduled-tasks').send(body);

  it('returns an empty list initially', async () => {
    const res = await request(h.app).get('/scheduled-tasks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ v: 1, tasks: [] });
  });

  it('creates a task (normalized view) and lists it', async () => {
    const res = await create({
      name: 'Digest',
      cron: '30 12 * * 1-5',
      prompt: 'summarize the day',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Digest',
      cron: '30 12 * * 1-5',
      prompt: 'summarize the day',
      recurring: true,
      enabled: true,
    });
    expect(typeof res.body.id).toBe('string');

    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0].id).toBe(res.body.id);
  });

  it('rejects an unparseable cron', async () => {
    const res = await create({ cron: 'not a cron', prompt: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_cron');
  });

  it('rejects a whitespace-only prompt', async () => {
    const res = await create({ cron: '0 9 * * *', prompt: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_prompt');
  });

  it('toggles enabled via PATCH', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'x' });
    const id = created.body.id as string;

    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ enabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(false);

    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].enabled).toBe(false);
  });

  it('clears the name when patched to an empty string', async () => {
    const created = await create({
      name: 'Named',
      cron: '0 9 * * *',
      prompt: 'p',
    });
    const id = created.body.id as string;
    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ name: '' });
    expect(patch.status).toBe(200);
    expect(patch.body.name).toBeNull();
  });

  it('404s when patching a missing task', async () => {
    const res = await request(h.app)
      .patch('/scheduled-tasks/missing1')
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
  });

  it('deletes a task, then 404s on repeat', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'x' });
    const id = created.body.id as string;

    const del = await request(h.app).delete(`/scheduled-tasks/${id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, id });

    const again = await request(h.app).delete(`/scheduled-tasks/${id}`);
    expect(again.status).toBe(404);
  });

  it('rejects a create past the max-tasks cap', async () => {
    for (let i = 0; i < 50; i++) {
      const r = await create({ cron: '0 9 * * *', prompt: `p${i}` });
      expect(r.status).toBe(201);
    }
    const over = await create({ cron: '0 9 * * *', prompt: 'overflow' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('max_tasks_reached');
  });

  it('updates cron / prompt / recurring via PATCH', async () => {
    const created = await create({
      cron: '0 9 * * *',
      prompt: 'orig',
      recurring: true,
    });
    const id = created.body.id as string;

    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ cron: '30 12 * * 1-5', prompt: 'updated', recurring: false });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({
      cron: '30 12 * * 1-5',
      prompt: 'updated',
      recurring: false,
    });

    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0]).toMatchObject({
      cron: '30 12 * * 1-5',
      prompt: 'updated',
      recurring: false,
    });
  });

  it('rejects an invalid cron via PATCH', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'x' });
    const id = created.body.id as string;
    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ cron: 'nope' });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('invalid_cron');
    // The bad PATCH must not have mutated the stored cron.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].cron).toBe('0 9 * * *');
  });

  it('rejects a PATCH with no updatable fields', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'x' });
    const id = created.body.id as string;
    const patch = await request(h.app).patch(`/scheduled-tasks/${id}`).send({});
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('empty_patch');
  });

  it('enforces POST field limits and boolean types', async () => {
    const longPrompt = await create({
      cron: '0 9 * * *',
      prompt: 'x'.repeat(100_001),
    });
    expect(longPrompt.status).toBe(400);
    expect(longPrompt.body.code).toBe('invalid_prompt');

    const longName = await create({
      cron: '0 9 * * *',
      prompt: 'x',
      name: 'n'.repeat(201),
    });
    expect(longName.status).toBe(400);
    expect(longName.body.code).toBe('invalid_name');

    const badRecurring = await create({
      cron: '0 9 * * *',
      prompt: 'x',
      recurring: 'yes',
    });
    expect(badRecurring.status).toBe(400);
    expect(badRecurring.body.code).toBe('invalid_recurring');

    const badEnabled = await create({
      cron: '0 9 * * *',
      prompt: 'x',
      enabled: 1,
    });
    expect(badEnabled.status).toBe(400);
    expect(badEnabled.body.code).toBe('invalid_enabled');
  });
});
