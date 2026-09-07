/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Storage,
  createThread,
  postMessage,
  updateMeshAgents,
  writeThread,
  type MeshAgent,
} from '@qwen-code/qwen-code-core';
import { registerMeshRoutes } from './mesh.js';

const ROOT = '/mesh-routes-test';
const ALICE: MeshAgent = {
  id: 'ag_alice',
  name: 'alice',
  description: 'reads CI logs',
  createdAt: 1,
};
const BOB: MeshAgent = { id: 'ag_bob', name: 'bob', createdAt: 1 };

function makeApp() {
  const app = express();
  app.use(express.json());
  registerMeshRoutes(app, { boundWorkspace: ROOT });
  return app;
}

describe('mesh routes', () => {
  let runtimeDir: string;

  beforeEach(async () => {
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-routes-'));
    Storage.setRuntimeBaseDir(runtimeDir);
    await updateMeshAgents(ROOT, () => [ALICE, BOB]);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  it('sends the resolver sentence with the status, so the client never derives one', async () => {
    const thread = await createThread(ROOT, {
      title: 'Investigate',
      assigneeAgentId: ALICE.id,
    });
    await postMessage(ROOT, thread.id, { from: 'user', text: 'have a look' });

    const listed = await request(makeApp()).get('/mesh/threads').expect(200);
    const row = listed.body.threads[0];

    expect(row.status).toBe('in_progress');
    expect(row.reason).toMatch(
      /still queued, running, finishing or cancelling/,
    );
    expect(row.liveRunCount).toBe(1);
  });

  it('recomputes a thread whose stored status went stale while the daemon was down', async () => {
    const created = await createThread(ROOT, { title: 'Stale' });
    // A crash can leave a thread reading in_progress with a run that will
    // never move again. The resolver is the definition of a thread's state, so
    // the first read after must correct the file rather than trust it.
    await writeThread(ROOT, {
      ...created,
      status: 'in_progress',
      runs: [
        {
          id: 'rn_dead',
          agentId: ALICE.id,
          status: 'failed',
          triggerMessageIds: [],
          acceptedMessageIds: [],
          consumedMessageIds: [],
          usageByRound: [],
          queueSequence: 900,
          queuedAt: 1,
          attempts: 1,
          error: 'launch failed',
        },
      ],
    });

    const listed = await request(makeApp()).get('/mesh/threads').expect(200);
    expect(listed.body.threads[0].status).toBe('blocked');
    expect(listed.body.threads[0].reason).toContain('failed');
  });

  it('reports unreadable threads instead of quietly showing a shorter list', async () => {
    const listed = await request(makeApp()).get('/mesh/threads').expect(200);
    expect(listed.body).toHaveProperty('unreadable');
  });

  it('describes each run by why it exists and whether a person owes it something', async () => {
    const thread = await createThread(ROOT, {
      title: 'Investigate',
      assigneeAgentId: ALICE.id,
    });
    await postMessage(ROOT, thread.id, { from: 'user', text: 'have a look' });

    const detail = await request(makeApp())
      .get(`/mesh/threads/${thread.id}`)
      .expect(200);

    expect(detail.body.runs[0].trigger).toBe('assigned by you');
    expect(detail.body.runs[0].agentName).toBe('alice');
    expect(detail.body.runs[0].closeAcknowledged).toBe(false);
    expect(detail.body.budget).toMatchObject({
      turnLimit: 12,
      tokenLimit: 200_000,
    });
  });

  it('previews the real routing without booking anything', async () => {
    const thread = await createThread(ROOT, {
      title: 'Investigate',
      assigneeAgentId: ALICE.id,
    });

    const preview = await request(makeApp())
      .post(`/mesh/threads/${thread.id}/preview`)
      .send({ text: 'please look, @bob and @nobody too' })
      .expect(200);

    const byName = Object.fromEntries(
      preview.body.targets.map((target: { agentName: string }) => [
        target.agentName,
        target,
      ]),
    );
    expect(byName['bob'].willWake).toBe(true);
    expect(byName['nobody']).toMatchObject({
      willWake: false,
      reason: 'agent_unknown',
      unknown: true,
    });
    // An explicit mention takes routing away from the assignee, and the
    // preview must show that before the post rather than after.
    expect(byName['alice']).toBeUndefined();

    const after = await request(makeApp())
      .get(`/mesh/threads/${thread.id}`)
      .expect(200);
    expect(after.body.runs).toHaveLength(0);
    expect(after.body.posts).toHaveLength(0);
  });

  it('tells the composer when a reply would reach nobody', async () => {
    const thread = await createThread(ROOT, { title: 'Unassigned' });

    const preview = await request(makeApp())
      .post(`/mesh/threads/${thread.id}/preview`)
      .send({ text: 'anyone?' })
      .expect(200);

    expect(preview.body.targets).toEqual([
      {
        agentName: 'nobody',
        willWake: false,
        reason: 'no_target',
        unknown: false,
      },
    ]);
  });

  it('authors a post as the person operating the shell, whatever the body says', async () => {
    const thread = await createThread(ROOT, {
      title: 'Investigate',
      assigneeAgentId: ALICE.id,
    });

    await request(makeApp())
      .post(`/mesh/threads/${thread.id}/posts`)
      .send({ text: 'have a look', from: ALICE.id, authorKind: 'agent' })
      .expect(200);

    const detail = await request(makeApp())
      .get(`/mesh/threads/${thread.id}`)
      .expect(200);
    expect(detail.body.posts[0]).toMatchObject({
      authorKind: 'human',
      authorName: 'user',
    });
  });

  it('refuses an empty post rather than appending a blank one', async () => {
    const thread = await createThread(ROOT, { title: 'Investigate' });
    await request(makeApp())
      .post(`/mesh/threads/${thread.id}/posts`)
      .send({ text: '   ' })
      .expect(400);
  });

  it('creates a thread and starts its assignee in the same request', async () => {
    const created = await request(makeApp())
      .post('/mesh/threads')
      .send({
        title: 'New work',
        body: 'Look at the retry path.',
        assignee: '@alice',
      })
      .expect(200);

    expect(created.body.booked).toBe(1);
    const detail = await request(makeApp())
      .get(`/mesh/threads/${created.body.id}`)
      .expect(200);
    expect(detail.body.runs[0].agentName).toBe('alice');
  });

  it('refuses an assignee nobody has heard of, rather than creating an orphan', async () => {
    await request(makeApp())
      .post('/mesh/threads')
      .send({ title: 'New work', assignee: 'ghost' })
      .expect(400);
  });

  it('refuses a second agent whose name differs only by case', async () => {
    // Names are the mention vocabulary; two that differ by case would make
    // routing a coin flip.
    const conflict = await request(makeApp())
      .post('/mesh/agents')
      .send({ name: 'Alice' })
      .expect(500);
    expect(conflict.body.error).toContain('already exists');
  });

  it('will not mark a parent done while a sub-thread is still open', async () => {
    const parent = await createThread(ROOT, { title: 'Parent' });
    const child = await createThread(ROOT, {
      title: 'Child',
      parentThreadId: parent.id,
    });

    const refused = await request(makeApp())
      .post(`/mesh/threads/${parent.id}/done`)
      .expect(409);
    // The refusal names what is holding it open, so the reader does not have
    // to guess which sub-thread to finish.
    expect(refused.body.descendants).toEqual([
      { id: child.id, title: 'Child' },
    ]);

    await request(makeApp()).post(`/mesh/threads/${child.id}/done`).expect(200);
    await request(makeApp())
      .post(`/mesh/threads/${parent.id}/done`)
      .expect(200);
  });

  it('lists agents with the thread each is on and the backlog behind it', async () => {
    const thread = await createThread(ROOT, {
      title: 'Investigate',
      assigneeAgentId: ALICE.id,
    });
    await postMessage(ROOT, thread.id, { from: 'user', text: 'have a look' });

    const listed = await request(makeApp()).get('/mesh/agents').expect(200);
    const alice = listed.body.agents.find(
      (agent: { name: string }) => agent.name === 'alice',
    );

    expect(alice.description).toBe('reads CI logs');
    expect(alice.enabled).toBe(true);
    expect(alice.waiting).toBe(1);
  });

  it('answers 404 for a thread that is not there', async () => {
    await request(makeApp()).get('/mesh/threads/th_missing').expect(404);
  });
});
