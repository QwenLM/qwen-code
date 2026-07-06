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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import {
  SessionService,
  Storage,
  getCronFilePath,
} from '@qwen-code/qwen-code-core';
import {
  registerScheduledTasksRoutes,
  scheduledTaskSessionName,
} from './scheduled-tasks.js';

function safeBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

/** Stub session bridge: mints sequential fake session ids and records spawns /
 * closes so tests can assert binding and rollback without a real child. */
interface StubBridge {
  spawnOrAttach(req: {
    workspaceCwd: string;
    sessionScope?: 'single' | 'thread';
  }): Promise<{ sessionId: string }>;
  closeSession(sessionId: string): Promise<unknown>;
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
  ): unknown;
  spawned: string[];
  spawnScopes: Array<'single' | 'thread' | undefined>;
  closed: string[];
  named: Array<{ sessionId: string; displayName?: string }>;
  failNext: boolean;
}

function makeStubBridge(): StubBridge {
  let seq = 0;
  const bridge: StubBridge = {
    spawned: [],
    spawnScopes: [],
    closed: [],
    named: [],
    failNext: false,
    async spawnOrAttach(req) {
      if (bridge.failNext) {
        bridge.failNext = false;
        throw new Error('spawn failed');
      }
      const sessionId = `sess-${++seq}`;
      bridge.spawned.push(sessionId);
      bridge.spawnScopes.push(req.sessionScope);
      return { sessionId };
    },
    async closeSession(sessionId: string) {
      bridge.closed.push(sessionId);
      return undefined;
    },
    updateSessionMetadata(sessionId, metadata) {
      bridge.named.push({ sessionId, ...metadata });
      return metadata;
    },
  };
  return bridge;
}

interface Harness {
  app: express.Application;
  scratch: string;
  workspace: string;
  bridge: StubBridge;
}

async function makeHarness(): Promise<Harness> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sched-route-'));
  const workspace = path.join(scratch, 'workspace');
  await fsp.mkdir(workspace, { recursive: true });
  // The durable tasks file lands under the runtime base dir, not the real
  // ~/.qwen — redirect it into the scratch dir for the duration of the test.
  Storage.setRuntimeBaseDir(scratch);

  const bridge = makeStubBridge();
  const app = express();
  app.use(express.json());
  registerScheduledTasksRoutes(app, {
    boundWorkspace: workspace,
    // Non-strict mutate is a passthrough (matches the loopback web-shell).
    mutate: () => (_req, _res, next) => next(),
    safeBody,
    bridge,
  });
  return { app, scratch, workspace, bridge };
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

  it('binds a created task to a freshly minted session', async () => {
    const res = await create({ cron: '0 9 * * *', prompt: 'p' });
    expect(res.status).toBe(201);
    // The task carries the id of the session the bridge minted for it.
    expect(h.bridge.spawned).toHaveLength(1);
    expect(res.body.sessionId).toBe(h.bridge.spawned[0]);
    // And it's persisted on disk, not just in the response.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].sessionId).toBe(h.bridge.spawned[0]);
    // No teardown on the happy path.
    expect(h.bridge.closed).toEqual([]);
  });

  it('creates an UNBOUND task (no session) when no bridge is provided', async () => {
    // Mirrors createServeApp passing no bridge when resident task-session
    // management is off: binding a task to a session nothing keeps resident /
    // reloads would leave it dormant, so those callers get unbound tasks.
    const app = express();
    app.use(express.json());
    registerScheduledTasksRoutes(app, {
      boundWorkspace: h.workspace,
      mutate: () => (_req, _res, next) => next(),
      safeBody,
      // no bridge
    });
    const res = await request(app)
      .post('/scheduled-tasks')
      .send({ cron: '0 9 * * *', prompt: 'p' });
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeNull(); // unbound — fires via shared owner
    expect(h.bridge.spawned).toEqual([]); // nothing was spawned
  });

  it('mints the task session with thread scope (never reuses the shared session)', async () => {
    // The daemon default scope is 'single' (attach to the shared workspace
    // session). A task MUST get its own isolated session, so the route forces
    // 'thread' — otherwise two tasks / a task + open chat would collide.
    await create({ cron: '0 9 * * *', prompt: 'p' });
    await create({ cron: '0 10 * * *', prompt: 'q' });
    expect(h.bridge.spawnScopes).toEqual(['thread', 'thread']);
    // Distinct sessions — no attach/reuse.
    expect(new Set(h.bridge.spawned).size).toBe(2);
  });

  it('names the bound session after the task (name preferred over prompt)', async () => {
    const named = await create({
      name: 'Digest',
      cron: '0 9 * * *',
      prompt: 'summarize the day',
    });
    expect(h.bridge.named).toEqual([
      { sessionId: named.body.sessionId, displayName: '⏰ Digest' },
    ]);

    const unnamed = await create({ cron: '0 9 * * *', prompt: 'do the thing' });
    expect(h.bridge.named[1]).toEqual({
      sessionId: unnamed.body.sessionId,
      displayName: '⏰ do the thing',
    });
  });

  it('returns 500 and writes nothing when the session cannot be minted', async () => {
    h.bridge.failNext = true;
    const res = await create({ cron: '0 9 * * *', prompt: 'p' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('scheduled_tasks_session_failed');
    // The task must not land on disk without its session.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toEqual([]);
  });

  it('rolls back the minted session (close + remove) when the commit fails', async () => {
    // Corrupt the tasks file so the spawn SUCCEEDS but the authoritative write
    // throws → the rollback must both close the live child AND remove the
    // persisted session, or a rejected create leaks an orphan session.
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'CORRUPT {{{', 'utf8');
    const removeSpy = vi
      .spyOn(SessionService.prototype, 'removeSession')
      .mockResolvedValue(true);
    try {
      const res = await create({ cron: '0 9 * * *', prompt: 'p' });
      expect(res.status).toBe(500);
      expect(h.bridge.spawned).toHaveLength(1); // spawn happened
      expect(h.bridge.closed).toEqual([h.bridge.spawned[0]]); // closed
      expect(removeSpy).toHaveBeenCalledWith(h.bridge.spawned[0]); // and removed
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('rejects an unparseable cron', async () => {
    const res = await create({ cron: 'not a cron', prompt: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_cron');
  });

  it('rejects a syntactically-valid but impossible cron (Feb 30)', async () => {
    // parseCron accepts "0 0 30 2 *" but nextFireTime rejects it — the route
    // runs both, so a task that could never fire is refused.
    const res = await create({ cron: '0 0 30 2 *', prompt: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_cron');
  });

  it('returns 500 when the tasks file is corrupt', async () => {
    // A file that exists but does not parse is corruption, not an empty
    // schedule; the route surfaces it rather than hiding the user's tasks.
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'NOT JSON {{{', 'utf8');
    const res = await request(h.app).get('/scheduled-tasks');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('scheduled_tasks_read_failed');
    // The client message must stay generic — no leak of the internal file path.
    expect(res.body.error).toBe(
      'Failed to read scheduled tasks (the tasks file may be corrupt)',
    );
    expect(res.body.error).not.toContain(file);
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
    // The task's dedicated session is torn down with it (no resident leak).
    expect(h.bridge.closed).toEqual([created.body.sessionId]);

    const again = await request(h.app).delete(`/scheduled-tasks/${id}`);
    expect(again.status).toBe(404);
    // A no-op delete (already gone) closes nothing further.
    expect(h.bridge.closed).toEqual([created.body.sessionId]);
  });

  it('records a manual run: advances lastFiredAt and appends a manual run', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'p' });
    const id = created.body.id as string;
    const before = created.body.lastFiredAt as number;

    const res = await request(h.app).post(`/scheduled-tasks/${id}/run`);
    expect(res.status).toBe(200);
    expect(res.body.lastFiredAt).toBeGreaterThan(before);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].kind).toBe('manual');
    // The manual run is tagged with the task's bound session.
    expect(res.body.runs[0].sessionId).toBe(created.body.sessionId);
  });

  it('404s a manual run for an unknown task', async () => {
    const res = await request(h.app).post(
      '/scheduled-tasks/does-not-exist/run',
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
  });

  it('refuses a manual run for a disabled task (409, no phantom record)', async () => {
    await seedTask({
      id: 'off1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: false,
    });
    const res = await request(h.app).post('/scheduled-tasks/off1/run');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('task_disabled');
    // No run recorded and lastFiredAt untouched.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].runs).toEqual([]);
    expect(list.body.tasks[0].lastFiredAt).toBe(1_700_000_000_000);
  });

  it('refuses a manual run for an archive-disabled task (409)', async () => {
    await seedTask({
      id: 'arch3',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: false,
      disabledByArchive: true,
      sessionId: 'sess-arch3',
    });
    const res = await request(h.app).post('/scheduled-tasks/arch3/run');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('task_disabled');
  });

  it('removes a ONE-SHOT task on manual run (so the scheduler cannot fire it again)', async () => {
    await seedTask({
      id: 'os-run',
      cron: '0 9 1 1 *',
      prompt: 'p',
      recurring: false,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: true,
    });
    const res = await request(h.app).post('/scheduled-tasks/os-run/run');
    expect(res.status).toBe(200);
    expect(res.body.runs.at(-1).kind).toBe('manual'); // run recorded in response
    expect(res.body.nextRunAt).toBeNull(); // consumed — no future fire advertised
    // The one-shot is gone from the store — its single fire already happened.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toEqual([]);
  });

  it('keeps a RECURRING task on manual run (only stamps lastFiredAt)', async () => {
    await seedTask({
      id: 'rec-run',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: true,
    });
    const res = await request(h.app).post('/scheduled-tasks/rec-run/run');
    expect(res.status).toBe(200);
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toHaveLength(1); // still scheduled
  });

  it('rejects a create past the max-tasks cap without spawning a session', async () => {
    for (let i = 0; i < 50; i++) {
      const r = await create({ cron: '0 9 * * *', prompt: `p${i}` });
      expect(r.status).toBe(201);
    }
    const over = await create({ cron: '0 9 * * *', prompt: 'overflow' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('max_tasks_reached');
    // The cap is pre-checked BEFORE spawning, so an over-cap create never mints
    // a session — no orphan task session to roll back (spawned stays at 50).
    expect(h.bridge.spawned).toHaveLength(50);
    expect(h.bridge.closed).toEqual([]);
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

  it('renames the bound session to follow the task name via PATCH', async () => {
    const created = await create({
      name: 'Old',
      cron: '0 9 * * *',
      prompt: 'p',
    });
    const id = created.body.id as string;
    const sid = created.body.sessionId as string;
    expect(h.bridge.named).toEqual([{ sessionId: sid, displayName: '⏰ Old' }]);

    // Renaming the task re-labels its session.
    const rename = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ name: 'New' });
    expect(rename.status).toBe(200);
    expect(h.bridge.named).toContainEqual({
      sessionId: sid,
      displayName: '⏰ New',
    });

    // A bare cron edit does NOT re-touch the session name.
    const count = h.bridge.named.length;
    await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ cron: '0 10 * * *' });
    expect(h.bridge.named).toHaveLength(count);

    // Clearing the name falls the session label back to the prompt.
    await request(h.app).patch(`/scheduled-tasks/${id}`).send({ name: '' });
    expect(h.bridge.named).toContainEqual({
      sessionId: sid,
      displayName: '⏰ p',
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

  // Seeds the on-disk file directly so a task can carry a real prior fire.
  const seedTask = async (task: Record<string, unknown>) => {
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify([task]), 'utf8');
  };

  it('normalizes a legacy task (no name/enabled) on GET', async () => {
    // Pre-fields format, as tool-created tasks were written before this PR.
    await seedTask({
      id: 'leg1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: null,
    });
    const res = await request(h.app).get('/scheduled-tasks');
    expect(res.status).toBe(200);
    // Backward compatibility: absent name → null, absent enabled → true.
    expect(res.body.tasks[0]).toMatchObject({
      id: 'leg1',
      name: null,
      enabled: true,
    });
    // Absent runs normalizes to an empty array (never undefined on the wire).
    expect(res.body.tasks[0].runs).toEqual([]);
  });

  it('surfaces on-disk run history on GET', async () => {
    await seedTask({
      id: 'h1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_540_000,
      runs: [
        { at: 1_700_000_480_000, kind: 'scheduled' },
        { at: 1_700_000_540_000, kind: 'catch-up' },
      ],
    });
    const res = await request(h.app).get('/scheduled-tasks');
    expect(res.status).toBe(200);
    expect(res.body.tasks[0].runs).toEqual([
      { at: 1_700_000_480_000, kind: 'scheduled' },
      { at: 1_700_000_540_000, kind: 'catch-up' },
    ]);
  });

  it('computes nextRunAt for an enabled task and nulls it when disabled', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'p' });
    expect(created.status).toBe(201);
    // Enabled → a concrete future fire time.
    expect(typeof created.body.nextRunAt).toBe('number');
    expect(created.body.nextRunAt).toBeGreaterThan(Date.now());

    // Disabling drops it — a paused task has no next run.
    const patched = await request(h.app)
      .patch(`/scheduled-tasks/${created.body.id}`)
      .send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.nextRunAt).toBeNull();

    // Re-enabling brings it back.
    const reenabled = await request(h.app)
      .patch(`/scheduled-tasks/${created.body.id}`)
      .send({ enabled: true });
    expect(typeof reenabled.body.nextRunAt).toBe('number');
  });

  it('rejects a task whose run history is malformed (fix-or-delete)', async () => {
    // A present-but-corrupt `runs` routes through the same read failure as any
    // other corrupt field rather than being silently dropped.
    await seedTask({
      id: 'bad1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: null,
      runs: [{ at: 'not-a-number' }],
    });
    const res = await request(h.app).get('/scheduled-tasks');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('scheduled_tasks_read_failed');
  });

  it('re-enabling a previously-fired task resumes from now (no catch-up)', async () => {
    const createdAt = 1_700_000_000_000;
    const firedAt = createdAt + 3 * 86_400_000; // a genuine past fire
    await seedTask({
      id: 'r1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt,
      lastFiredAt: firedAt,
      enabled: false,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/r1')
      .send({ enabled: true });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(true);
    // lastFiredAt advanced to ~now so the scheduler won't catch up the fires
    // it "missed" while paused.
    expect(patch.body.lastFiredAt).toBeGreaterThan(firedAt);
    expect(patch.body.lastFiredAt).toBeGreaterThanOrEqual(now - (now % 60_000));
  });

  it('re-enabling a recurring task disabled before its first run also resumes from now', async () => {
    // A task paused before ever firing must not catch-up its missed slot on
    // re-enable — every recurring false→true transition is stamped to now.
    const createdAt = 1_700_000_000_000;
    const createdMinute = createdAt - (createdAt % 60_000);
    await seedTask({
      id: 'n1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt,
      lastFiredAt: createdMinute, // never actually fired
      enabled: false,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/n1')
      .send({ enabled: true });
    expect(patch.status).toBe(200);
    expect(patch.body.lastFiredAt).toBeGreaterThan(createdMinute);
    expect(patch.body.lastFiredAt).toBeGreaterThanOrEqual(now - (now % 60_000));
  });

  it('re-enabling a one-shot task leaves its anchor untouched', async () => {
    const createdAt = 1_700_000_000_000;
    const lastFiredAt = createdAt - (createdAt % 60_000);
    await seedTask({
      id: 'o1',
      cron: '0 9 1 1 *',
      prompt: 'p',
      recurring: false,
      createdAt,
      lastFiredAt,
      enabled: false,
    });
    const patch = await request(h.app)
      .patch('/scheduled-tasks/o1')
      .send({ enabled: true });
    expect(patch.status).toBe(200);
    expect(patch.body.lastFiredAt).toBe(lastFiredAt); // unchanged (not recurring)
  });

  it('editing an enabled recurring task cron re-seats the anchor to now (no catch-up on save)', async () => {
    // A bare cron edit must not let the next file-watch reload retroactively
    // fire an already-past slot of the NEW expression — critical for a bound
    // task, whose catch-up runs on every reload, not just initial load.
    const createdAt = 1_700_000_000_000;
    const firedAt = createdAt + 3 * 86_400_000; // a genuine past fire
    await seedTask({
      id: 'c1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt,
      lastFiredAt: firedAt,
      enabled: true,
      sessionId: 'sess-x',
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/c1')
      .send({ cron: '30 8 * * *' });
    expect(patch.status).toBe(200);
    expect(patch.body.cron).toBe('30 8 * * *');
    expect(patch.body.lastFiredAt).toBeGreaterThan(firedAt);
    expect(patch.body.lastFiredAt).toBeGreaterThanOrEqual(now - (now % 60_000));
  });

  it('a cosmetically-different but equivalent cron does NOT re-seat the anchor', async () => {
    // `0 9 * * *` → `00 9 * * *` fires identically; re-seating would drop a
    // legitimately-pending catch-up. The comparison is on the effective schedule.
    const createdAt = 1_700_000_000_000;
    const firedAt = createdAt + 3 * 86_400_000;
    await seedTask({
      id: 'eq1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt,
      lastFiredAt: firedAt,
      enabled: true,
    });
    const patch = await request(h.app)
      .patch('/scheduled-tasks/eq1')
      .send({ cron: '00 9 * * *' });
    expect(patch.status).toBe(200);
    expect(patch.body.cron).toBe('00 9 * * *'); // stored verbatim
    expect(patch.body.lastFiredAt).toBe(firedAt); // anchor untouched
  });

  it('editing only the prompt of an enabled recurring task leaves the anchor untouched', async () => {
    // A non-schedule edit must NOT disturb the firing anchor.
    const createdAt = 1_700_000_000_000;
    const firedAt = createdAt + 3 * 86_400_000;
    await seedTask({
      id: 'p2',
      cron: '0 9 * * *',
      prompt: 'orig',
      recurring: true,
      createdAt,
      lastFiredAt: firedAt,
      enabled: true,
    });
    const patch = await request(h.app)
      .patch('/scheduled-tasks/p2')
      .send({ prompt: 'updated' });
    expect(patch.status).toBe(200);
    expect(patch.body.prompt).toBe('updated');
    expect(patch.body.lastFiredAt).toBe(firedAt); // schedule untouched
  });

  it('flipping a one-shot task to recurring re-seats the anchor to now', async () => {
    // The anchor source flips from createdAt to lastFiredAt, so re-seat it.
    const createdAt = 1_700_000_000_000;
    await seedTask({
      id: 'x1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: false,
      createdAt,
      lastFiredAt: createdAt - (createdAt % 60_000),
      enabled: true,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/x1')
      .send({ recurring: true });
    expect(patch.status).toBe(200);
    expect(patch.body.recurring).toBe(true);
    expect(patch.body.lastFiredAt).toBeGreaterThanOrEqual(now - (now % 60_000));
  });

  it('flipping recurring→one-shot re-seats createdAt so it fires next, not as missed', async () => {
    // A long-ago createdAt would make the new one-shot read as a MISSED slot the
    // scheduler fires + deletes immediately. Re-seating createdAt to now points
    // its next fire at the upcoming occurrence instead.
    const createdAt = 1_700_000_000_000;
    const firedAt = createdAt + 3 * 86_400_000;
    await seedTask({
      id: 'r2o',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt,
      lastFiredAt: firedAt,
      enabled: true,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/r2o')
      .send({ recurring: false });
    expect(patch.status).toBe(200);
    expect(patch.body.recurring).toBe(false);
    expect(patch.body.createdAt).toBeGreaterThanOrEqual(now - 5_000); // re-seated
    expect(patch.body.nextRunAt).toBeGreaterThan(now); // fires at NEXT occurrence
  });

  it('re-seats a schedule edit made while DISABLED (so a later re-enable is not a missed fire)', async () => {
    // Edit a disabled one-shot's cron in one request, re-enable in another. The
    // re-seat must happen at edit time (even disabled), or the re-enable — which
    // has no schedule change of its own — leaves a weeks-old anchor that fires
    // + deletes the task immediately.
    const createdAt = 1_700_000_000_000;
    await seedTask({
      id: 'do1',
      cron: '0 9 1 1 *',
      prompt: 'p',
      recurring: false,
      createdAt,
      lastFiredAt: createdAt,
      enabled: false,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/do1')
      .send({ cron: '30 8 1 1 *' });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(false); // still disabled
    expect(patch.body.createdAt).toBeGreaterThanOrEqual(now - 5_000); // re-seated now
  });

  it('editing an ENABLED one-shot cron re-seats createdAt (fires next, not as missed)', async () => {
    const createdAt = 1_700_000_000_000; // long past
    await seedTask({
      id: 'eo1',
      cron: '0 9 1 1 *',
      prompt: 'p',
      recurring: false,
      createdAt,
      lastFiredAt: createdAt,
      enabled: true,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/eo1')
      .send({ cron: '30 8 1 1 *' });
    expect(patch.status).toBe(200);
    expect(patch.body.createdAt).toBeGreaterThanOrEqual(now - 5_000); // re-seated
    expect(patch.body.nextRunAt).toBeGreaterThan(now); // fires at NEXT occurrence
  });

  it('rejects re-enabling an archive-disabled task via PATCH (409, no write)', async () => {
    // Disabled BY archiving its session — re-enabling here would show it enabled
    // while the session stays archived and can't fire. Must unarchive instead.
    await seedTask({
      id: 'arch1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: false,
      disabledByArchive: true,
      sessionId: 'sess-arch',
    });
    const patch = await request(h.app)
      .patch('/scheduled-tasks/arch1')
      .send({ enabled: true });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe('task_session_archived');
    // The file was not mutated — the task stays disabled with its marker.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].enabled).toBe(false);
  });

  it('still allows re-enabling a user-disabled task (no archive marker) via PATCH', async () => {
    // enabled:false WITHOUT disabledByArchive = the user's own off switch.
    await seedTask({
      id: 'usr1',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: false,
    });
    const patch = await request(h.app)
      .patch('/scheduled-tasks/usr1')
      .send({ enabled: true });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(true);
  });

  it('lets an archive-disabled task be edited in other ways (cron) without re-enabling', async () => {
    // Only enabled:true is blocked; a cron edit that leaves it disabled is fine.
    await seedTask({
      id: 'arch2',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: false,
      disabledByArchive: true,
      sessionId: 'sess-arch2',
    });
    const patch = await request(h.app)
      .patch('/scheduled-tasks/arch2')
      .send({ cron: '30 8 * * *' });
    expect(patch.status).toBe(200);
    expect(patch.body.cron).toBe('30 8 * * *');
    expect(patch.body.enabled).toBe(false); // still disabled
  });
});

describe('scheduledTaskSessionName', () => {
  it('prefixes the clock and collapses whitespace', () => {
    expect(scheduledTaskSessionName('  Daily   digest ')).toBe(
      '⏰ Daily digest',
    );
  });

  it('strips terminal control sequences (else the bridge guard drops the rename)', () => {
    // The CSI sequence is flattened to a space (and collapsed), leaving no
    // control char to trip the bridge's title guard.
    const name = scheduledTaskSessionName('ab\x1b[31mc');
    expect(name).toBe('⏰ ab c');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f-\x9f]/.test(name)).toBe(false);
  });

  it('truncates on a code-point boundary (no lone surrogate)', () => {
    // 59 ASCII then an emoji straddling the 60-char cap — a naive slice would
    // split its surrogate pair, leaving an orphaned high surrogate.
    const name = scheduledTaskSessionName('x'.repeat(59) + '\u{1F600}tail');
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = name.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true); // always paired
      }
    }
    expect(name.endsWith('…')).toBe(true);
  });
});
