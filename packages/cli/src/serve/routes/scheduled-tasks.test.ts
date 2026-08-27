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
  readCronTasks,
  updateCronTasks,
} from '@qwen-code/qwen-code-core';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import {
  registerScheduledTasksRoutes,
  registerWorkspaceQualifiedScheduledTasksRoutes,
  createScheduledTaskWithExistingSession,
  scheduledTaskSessionName,
} from './scheduled-tasks.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { ChannelDeliveryAuthorizationStore } from '../channel-delivery-authorization.js';
import { ConversationRuntimeActivityGate } from '../conversations/conversation-runtime-activity.js';

function safeBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

const CALLER_SESSION_ID = '10000000-0000-4000-8000-000000000001';
const MISSING_SESSION_ID = '10000000-0000-4000-8000-000000000002';
const OTHER_SESSION_ID = '10000000-0000-4000-8000-000000000003';
const BUSY_SESSION_ID = '10000000-0000-4000-8000-000000000004';
const SECONDARY_SESSION_ID = '10000000-0000-4000-8000-000000000005';

/** Stub session bridge: mints sequential fake session ids and records spawns /
 * closes so tests can assert binding and rollback without a real child. */
interface StubBridge {
  spawnOrAttach(req: {
    workspaceCwd: string;
    sessionScope?: 'single' | 'thread';
    parentSessionId?: string;
    sourceType?: string;
    sourceId?: string;
  }): Promise<{ sessionId: string }>;
  sendPrompt(
    sessionId: string,
    req: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> },
  ): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  ensureDefaultSessionPersisted(sessionId: string): Promise<void>;
  updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
  ): unknown;
  getSessionSummary(sessionId: string): {
    sessionId: string;
    workspaceCwd: string;
    hasActivePrompt: boolean;
    pendingInteractionCount?: number;
    parentSessionId?: string;
    sourceType?: string;
    sourceId?: string;
  };
  liveSessions: Map<
    string,
    {
      sessionId: string;
      workspaceCwd: string;
      hasActivePrompt: boolean;
      pendingInteractionCount?: number;
      parentSessionId?: string;
      sourceType?: string;
      sourceId?: string;
    }
  >;
  markSessionCatalogChanged: ReturnType<typeof vi.fn>;
  spawned: string[];
  spawnScopes: Array<'single' | 'thread' | undefined>;
  spawnSources: Array<{ sourceType?: string; sourceId?: string }>;
  spawnParents: Array<string | undefined>;
  prompts: Array<{ sessionId: string; text: string }>;
  closed: string[];
  persisted: string[];
  named: Array<{ sessionId: string; displayName?: string }>;
  failNext: boolean;
  persistenceError?: Error;
}

function makeStubBridge(): StubBridge {
  let seq = 0;
  const bridge: StubBridge = {
    spawned: [],
    spawnScopes: [],
    spawnSources: [],
    spawnParents: [],
    prompts: [],
    closed: [],
    persisted: [],
    named: [],
    markSessionCatalogChanged: vi.fn(),
    failNext: false,
    liveSessions: new Map(),
    async spawnOrAttach(req) {
      if (bridge.failNext) {
        bridge.failNext = false;
        throw new Error('spawn failed');
      }
      const sessionId = `sess-${++seq}`;
      bridge.spawned.push(sessionId);
      bridge.spawnScopes.push(req.sessionScope);
      bridge.spawnParents.push(req.parentSessionId);
      bridge.spawnSources.push({
        ...(req.sourceType !== undefined ? { sourceType: req.sourceType } : {}),
        ...(req.sourceId !== undefined ? { sourceId: req.sourceId } : {}),
      });
      bridge.liveSessions.set(sessionId, {
        sessionId,
        workspaceCwd: req.workspaceCwd,
        hasActivePrompt: false,
        ...(req.sourceType !== undefined ? { sourceType: req.sourceType } : {}),
      });
      return { sessionId };
    },
    async sendPrompt(sessionId, req) {
      bridge.prompts.push({ sessionId, text: req.prompt[0]?.text ?? '' });
      return { stopReason: 'end_turn' };
    },
    async closeSession(sessionId: string) {
      bridge.closed.push(sessionId);
      bridge.liveSessions.delete(sessionId);
      return undefined;
    },
    async ensureDefaultSessionPersisted(sessionId: string) {
      if (bridge.persistenceError) throw bridge.persistenceError;
      if (!bridge.liveSessions.has(sessionId)) {
        throw new SessionNotFoundError(sessionId);
      }
      bridge.persisted.push(sessionId);
    },
    updateSessionMetadata(sessionId, metadata) {
      bridge.named.push({ sessionId, ...metadata });
      return metadata;
    },
    getSessionSummary(sessionId) {
      const summary = bridge.liveSessions.get(sessionId);
      if (!summary) throw new SessionNotFoundError(sessionId);
      return summary;
    },
  };
  return bridge;
}

function addLiveSession(
  bridge: StubBridge,
  sessionId: string,
  workspaceCwd: string,
  options: {
    busy?: boolean;
    pendingInteractionCount?: number;
    parentSessionId?: string;
    sourceType?: string;
    sourceId?: string;
  } = {},
): void {
  bridge.liveSessions.set(sessionId, {
    sessionId,
    workspaceCwd,
    hasActivePrompt: options.busy === true,
    ...(options.pendingInteractionCount !== undefined
      ? { pendingInteractionCount: options.pendingInteractionCount }
      : {}),
    ...(options.parentSessionId !== undefined
      ? { parentSessionId: options.parentSessionId }
      : {}),
    ...(options.sourceType ? { sourceType: options.sourceType } : {}),
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
  });
}

interface Harness {
  app: express.Application;
  scratch: string;
  workspace: string;
  bridge: StubBridge;
  cleanupSession: ReturnType<typeof vi.fn>;
  channelDeliveryAuthorizations: ChannelDeliveryAuthorizationStore;
}

async function makeHarness(
  runtimeTrusted?: boolean,
  generationGuard?: WorkspaceRuntime['generationGuard'],
): Promise<Harness> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sched-route-'));
  const workspace = path.join(scratch, 'workspace');
  await fsp.mkdir(workspace, { recursive: true });
  // The durable tasks file lands under the runtime base dir, not the real
  // ~/.qwen — redirect it into the scratch dir for the duration of the test.
  Storage.setRuntimeBaseDir(scratch);

  const bridge = makeStubBridge();
  const channelDeliveryAuthorizations = new ChannelDeliveryAuthorizationStore();
  const getRuntime =
    runtimeTrusted === undefined
      ? undefined
      : () =>
          ({
            workspaceId: 'primary',
            workspaceCwd: workspace,
            sessionRuntimeBaseDir: scratch,
            primary: true,
            trusted: runtimeTrusted,
            bridge,
            generationGuard,
          }) as unknown as WorkspaceRuntime;
  const cleanupSession = vi.fn(
    async (_runtime: WorkspaceRuntime, sessionId: string) => {
      await bridge.closeSession(sessionId);
      await new SessionService(workspace, {
        runtimeBaseDir: scratch,
      }).removeSession(sessionId);
    },
  );
  const app = express();
  app.use(express.json());
  registerScheduledTasksRoutes(app, {
    boundWorkspace: workspace,
    // Non-strict mutate is a passthrough (matches the loopback web-shell).
    mutate: () => (_req, _res, next) => next(),
    safeBody,
    bridge,
    channelDeliveryAuthorizations,
    ...(getRuntime ? { getRuntime, cleanupSession } : {}),
  });
  return {
    app,
    scratch,
    workspace,
    bridge,
    cleanupSession,
    channelDeliveryAuthorizations,
  };
}

async function teardown(h: Harness): Promise<void> {
  Storage.setRuntimeBaseDir(null);
  await fsp.rm(h.scratch, { recursive: true, force: true });
}

function closeGenerationDuringCronCommit(): WorkspaceRuntime['generationGuard'] {
  let open = true;
  let checks = 0;
  return {
    get closed() {
      return !open;
    },
    assertOpen() {
      checks += 1;
      if (!open) {
        throw Object.assign(new Error('generation closed'), {
          code: 'workspace_generation_closed',
        });
      }
      if (checks === 3) queueMicrotask(() => (open = false));
    },
    close() {
      open = false;
    },
  };
}

describe('scheduled-tasks routes', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await teardown(h);
  });

  it('rejects primary scheduled-task writes after trust is revoked', async () => {
    await teardown(h);
    h = await makeHarness(false);

    const res = await request(h.app)
      .post('/scheduled-tasks')
      .send({ cron: '* * * * *', prompt: 'blocked' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(h.bridge.spawned).toHaveLength(0);
  });

  it('returns 503 and removes the new session when generation closes after spawn', async () => {
    await teardown(h);
    let generationOpen = true;
    h = await makeHarness(true, {
      get closed() {
        return !generationOpen;
      },
      assertOpen() {
        if (!generationOpen) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {
        generationOpen = false;
      },
    });
    const spawn = h.bridge.spawnOrAttach.bind(h.bridge);
    h.bridge.spawnOrAttach = async (input) => {
      const session = await spawn(input);
      generationOpen = false;
      return session;
    };

    const res = await request(h.app)
      .post('/scheduled-tasks')
      .send({ cron: '* * * * *', prompt: 'stale' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(h.cleanupSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: h.workspace }),
      'sess-1',
    );
    expect(h.bridge.closed).toEqual(['sess-1']);
    await expect(
      fsp.readFile(getCronFilePath(h.workspace), 'utf8'),
    ).rejects.toThrow();
  });

  it('does not spawn a session when generation closes during the cap precheck', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness(true, {
      closed: false,
      assertOpen() {
        checks += 1;
        if (checks === 2) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {},
    });

    const res = await request(h.app)
      .post('/scheduled-tasks')
      .send({ cron: '* * * * *', prompt: 'stale' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(h.bridge.spawned).toEqual([]);
  });

  it('rolls back the task and session when generation closes after commit', async () => {
    await teardown(h);
    let checks = 0;
    let generationOpen = true;
    h = await makeHarness(true, {
      get closed() {
        return !generationOpen;
      },
      assertOpen() {
        checks += 1;
        if (!generationOpen) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
        if (checks === 5) {
          queueMicrotask(() => {
            generationOpen = false;
          });
        }
      },
      close() {
        generationOpen = false;
      },
    });

    const res = await request(h.app)
      .post('/scheduled-tasks')
      .send({ cron: '* * * * *', prompt: 'stale' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(h.bridge.closed).toEqual(['sess-1']);
    expect(await readCronTasks(h.workspace)).toEqual([]);
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
      sessionMode: 'persistent',
    });
    expect(typeof res.body.id).toBe('string');

    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0].id).toBe(res.body.id);
  });

  it('dispatches each manual per-run fire into a fresh child session', async () => {
    const created = await create({
      name: 'Review PRs',
      cron: '0 * * * *',
      prompt: 'review the next PR',
      sessionMode: 'per_run',
    });
    expect(created.status).toBe(201);
    expect(created.body.sessionMode).toBe('per_run');
    const controllerSessionId = created.body.sessionId as string;

    const run = await request(h.app).post(
      `/scheduled-tasks/${created.body.id}/run`,
    );

    expect(run.status).toBe(200);
    const childSessionId = h.bridge.spawned[1]!;
    expect(childSessionId).not.toBe(controllerSessionId);
    expect(h.bridge.spawnParents[1]).toBe(controllerSessionId);
    expect(h.bridge.spawnSources[1]).toEqual({
      sourceType: 'default',
      sourceId: `scheduled_task_run:${created.body.id}`,
    });
    expect(h.bridge.named[1]).toEqual({
      sessionId: childSessionId,
      // Task label + local trigger time, so runs are told apart in the list.
      displayName: expect.stringMatching(
        /^Review PRs · \d{2}-\d{2} \d{2}:\d{2}$/,
      ),
    });
    expect(h.bridge.prompts).toHaveLength(1);
    expect(h.bridge.prompts[0]).toMatchObject({ sessionId: childSessionId });
    expect(h.bridge.prompts[0]?.text).toContain('Scheduled task: Review PRs');
    expect(h.bridge.prompts[0]?.text).toContain(`Task ID: ${created.body.id}`);
    expect(h.bridge.prompts[0]?.text).toContain('Schedule: 0 * * * *');
    expect(h.bridge.prompts[0]?.text).toContain('Trigger: manual');
    expect(h.bridge.prompts[0]?.text).toContain(
      'This is a scheduled task run. Execute the instructions below now.',
    );
    expect(h.bridge.prompts[0]?.text).toMatch(/\n\nreview the next PR$/);
    expect(run.body.runs.at(-1)).toMatchObject({
      kind: 'manual',
      sessionId: childSessionId,
    });
    const stored = await readCronTasks(h.workspace);
    expect(stored[0]?.sessionMode).toBe('per_run');
    expect(stored[0]?.runs?.at(-1)?.sessionId).toBe(childSessionId);
  });

  it('restores a per-run one-shot when fresh-session admission fails', async () => {
    const created = await create({
      cron: '0 0 1 1 *',
      prompt: 'run once',
      recurring: false,
      sessionMode: 'per_run',
    });
    h.bridge.failNext = true;

    const run = await request(h.app).post(
      `/scheduled-tasks/${created.body.id}/run`,
    );

    expect(run.status).toBe(500);
    expect(run.body.code).toBe('scheduled_task_session_dispatch_failed');
    const stored = await readCronTasks(h.workspace);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: created.body.id,
      recurring: false,
      sessionMode: 'per_run',
    });
    expect(stored[0]?.runs).toBeUndefined();
  });

  it('restores a consumed one-shot even when an unrelated write lands during dispatch', async () => {
    // The one-shot is removed from the store before dispatch so it cannot race
    // its scheduled slot. The undo must not be gated on the file still being
    // byte-identical: a recurring task's tick persist, a keepalive binding, or
    // another client's PATCH can land inside the dispatch window, and an
    // equality-gated undo would destroy a schedule that never executed.
    const created = await create({
      cron: '0 0 1 1 *',
      prompt: 'run once',
      recurring: false,
      sessionMode: 'per_run',
    });
    const spawnOrAttach = h.bridge.spawnOrAttach.bind(h.bridge);
    h.bridge.spawnOrAttach = async (req) => {
      // An unrelated task appears on the same workspace file mid-dispatch.
      await updateCronTasks(h.workspace, (tasks) => [
        ...tasks,
        {
          id: 'concurrent-task',
          cron: '0 9 * * *',
          prompt: 'unrelated',
          recurring: true,
          createdAt: 1_700_000_000_000,
          lastFiredAt: 1_700_000_000_000,
          sessionId: CALLER_SESSION_ID,
        },
      ]);
      await spawnOrAttach(req);
      throw new Error('spawn failed');
    };

    const run = await request(h.app).post(
      `/scheduled-tasks/${created.body.id}/run`,
    );

    expect(run.status).toBe(500);
    expect(run.body.code).toBe('scheduled_task_session_dispatch_failed');
    const stored = await readCronTasks(h.workspace);
    // The retry the 500 invites must find the task, not a 404.
    expect(stored.map((t) => t.id).sort()).toEqual(
      ['concurrent-task', created.body.id].sort(),
    );
    expect(stored.find((t) => t.id === created.body.id)).toMatchObject({
      recurring: false,
      sessionMode: 'per_run',
    });
  });

  it('rejects a per-run conversion on a task with no bound session', async () => {
    // Tool-created durable tasks start unbound (`cron_create` omits sessionId)
    // and the dialog offers Edit unconditionally. Accepting the conversion
    // would leave a task whose every manual run 500s with a phantom failed-run
    // record until the keepalive heartbeat binds it.
    await updateCronTasks(h.workspace, (tasks) => [
      ...tasks,
      {
        id: 'unbound-task',
        cron: '0 9 * * *',
        prompt: 'unbound',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: 1_700_000_000_000,
      },
    ]);

    const res = await request(h.app)
      .patch('/scheduled-tasks/unbound-task')
      .send({ sessionMode: 'per_run' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_mode_requires_bound_session');
    const stored = await readCronTasks(h.workspace);
    expect(stored.find((t) => t.id === 'unbound-task')?.sessionMode).toBe(
      undefined,
    );
  });

  it('rejects invalid or channel-delivery per-run session modes', async () => {
    const invalid = await create({
      cron: '0 * * * *',
      prompt: 'p',
      sessionMode: 'new',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_session_mode');

    const delivery = await create({
      cron: '0 * * * *',
      prompt: 'p',
      sessionMode: 'per_run',
      delivery: {
        kind: 'channel',
        target: { channelName: 'dingtalk', type: 'user', id: 'u1' },
      },
    });
    expect(delivery.status).toBe(400);
    expect(delivery.body.code).toBe('session_mode_delivery_unsupported');
    expect(h.bridge.spawned).toEqual([]);
  });

  it('creates and persists a task with channel delivery', async () => {
    const delivery = {
      kind: 'channel',
      target: {
        channelName: 'dingtalk',
        type: 'user' as const,
        id: 'user-1',
      },
    };

    const res = await create({
      cron: '30 12 * * 1-5',
      prompt: 'summarize the day',
      delivery,
    });

    expect(res.status).toBe(201);
    expect(res.body.delivery).toEqual(delivery);
    const firedAt = res.body.lastFiredAt + 60_000;
    expect(
      h.channelDeliveryAuthorizations.consume(h.workspace, {
        sessionId: res.body.sessionId,
        deliveryId: `${res.body.id}:${firedAt}`,
        source: 'scheduled',
        taskId: res.body.id,
        firedAt,
        target: delivery.target,
      }),
    ).toBe(true);
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].delivery).toEqual(delivery);
  });

  it('rejects malformed delivery before creating a task session', async () => {
    const res = await create({
      cron: '30 12 * * 1-5',
      prompt: 'summarize the day',
      delivery: {
        kind: 'channel',
        channelName: 'dingtalk',
        target: { type: 'user', id: 'user-1' },
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('channel_delivery_invalid');
    expect(h.bridge.spawned).toEqual([]);
  });

  it('updates delivery via PATCH (sole field)', async () => {
    const created = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      delivery: {
        kind: 'channel',
        target: { channelName: 'dingtalk', type: 'user', id: 'user-1' },
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const sid = created.body.sessionId as string;

    const newDelivery = {
      kind: 'channel',
      target: { channelName: 'feishu', type: 'chat' as const, id: 'chat-2' },
    };
    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ delivery: newDelivery });
    expect(patch.status).toBe(200);
    expect(patch.body.delivery).toEqual(newDelivery);

    // The authorization store reflects the new target.
    const firedAt = patch.body.lastFiredAt + 60_000;
    expect(
      h.channelDeliveryAuthorizations.consume(h.workspace, {
        sessionId: sid,
        deliveryId: `${id}:${firedAt}`,
        source: 'scheduled',
        taskId: id,
        firedAt,
        target: newDelivery.target,
      }),
    ).toBe(true);
    // The old target's authorization is revoked.
    expect(
      h.channelDeliveryAuthorizations.consume(h.workspace, {
        sessionId: sid,
        deliveryId: `${id}:${firedAt}`,
        source: 'scheduled',
        taskId: id,
        firedAt,
        target: {
          channelName: 'dingtalk',
          type: 'user' as const,
          id: 'user-1',
        },
      }),
    ).toBe(false);
  });

  it('clears delivery via PATCH with null', async () => {
    const created = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      delivery: {
        kind: 'channel',
        target: { channelName: 'dingtalk', type: 'user', id: 'user-1' },
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const sid = created.body.sessionId as string;

    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ delivery: null });
    expect(patch.status).toBe(200);
    expect(patch.body.delivery).toBeUndefined();

    // The authorization is revoked — a delivery against the old target fails.
    const firedAt = patch.body.lastFiredAt + 60_000;
    expect(
      h.channelDeliveryAuthorizations.consume(h.workspace, {
        sessionId: sid,
        deliveryId: `${id}:${firedAt}`,
        source: 'scheduled',
        taskId: id,
        firedAt,
        target: {
          channelName: 'dingtalk',
          type: 'user' as const,
          id: 'user-1',
        },
      }),
    ).toBe(false);
  });

  it('rejects malformed delivery via PATCH (400, task unchanged)', async () => {
    const created = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      delivery: {
        kind: 'channel',
        target: { channelName: 'dingtalk', type: 'user', id: 'user-1' },
      },
    });
    const id = created.body.id as string;

    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ delivery: { kind: 'channel', bad: true } });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('channel_delivery_invalid');

    // The stored delivery is untouched.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].delivery).toEqual({
      kind: 'channel',
      target: { channelName: 'dingtalk', type: 'user', id: 'user-1' },
    });
  });

  it('adds delivery to a task that had none via PATCH', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'p' });
    expect(created.status).toBe(201);
    expect(created.body.delivery).toBeUndefined();
    const id = created.body.id as string;
    const sid = created.body.sessionId as string;

    const delivery = {
      kind: 'channel',
      target: { channelName: 'feishu', type: 'user' as const, id: 'user-9' },
    };
    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ delivery });
    expect(patch.status).toBe(200);
    expect(patch.body.delivery).toEqual(delivery);

    // The authorization store now accepts deliveries for the new target.
    const firedAt = patch.body.lastFiredAt + 60_000;
    expect(
      h.channelDeliveryAuthorizations.consume(h.workspace, {
        sessionId: sid,
        deliveryId: `${id}:${firedAt}`,
        source: 'scheduled',
        taskId: id,
        firedAt,
        target: delivery.target,
      }),
    ).toBe(true);
  });

  it('binds a created task to a freshly minted session', async () => {
    const res = await create({ cron: '0 9 * * *', prompt: 'p' });
    expect(res.status).toBe(201);
    // The task carries the id of the session the bridge minted for it.
    expect(h.bridge.spawned).toHaveLength(1);
    expect(res.body.sessionId).toBe(h.bridge.spawned[0]);
    expect(h.bridge.spawnSources).toEqual([
      { sourceType: 'scheduled_task', sourceId: res.body.id },
    ]);
    // And it's persisted on disk, not just in the response.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].sessionId).toBe(h.bridge.spawned[0]);
    // No teardown on the happy path.
    expect(h.bridge.closed).toEqual([]);
  });

  it('uses the bridge from the captured runtime generation', async () => {
    const runtimeBridge = makeStubBridge();
    const liveBridge = makeStubBridge();
    const app = express();
    app.use(express.json());
    registerScheduledTasksRoutes(app, {
      boundWorkspace: h.workspace,
      mutate: () => (_req, _res, next) => next(),
      safeBody,
      bridge: liveBridge,
      getRuntime: () =>
        ({
          workspaceId: 'primary',
          workspaceCwd: h.workspace,
          primary: true,
          trusted: true,
          bridge: runtimeBridge,
        }) as unknown as WorkspaceRuntime,
    });

    const res = await request(app)
      .post('/scheduled-tasks')
      .send({ cron: '0 9 * * *', prompt: 'p' });

    expect(res.status).toBe(201);
    expect(runtimeBridge.spawned).toEqual([res.body.sessionId]);
    expect(liveBridge.spawned).toEqual([]);
  });

  it('allows a prompt-only edit of a per_run task where dispatch is unavailable', async () => {
    // The edit dialog prefills and re-sends the task's own sessionMode on every
    // PATCH. Gating on the raw value would make a per_run task already on disk
    // unsavable wherever task-session management is off — the user could only
    // save by switching to persistent, silently changing its run semantics.
    await updateCronTasks(h.workspace, (tasks) => [
      ...tasks,
      {
        id: 'seeded-per-run',
        cron: '0 9 * * *',
        prompt: 'before',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: 1_700_000_000_000,
        sessionId: CALLER_SESSION_ID,
        sessionMode: 'per_run',
      },
    ]);
    const app = express();
    app.use(express.json());
    registerScheduledTasksRoutes(app, {
      boundWorkspace: h.workspace,
      mutate: () => (_req, _res, next) => next(),
      safeBody,
      // no bridge — fresh-session dispatch is unavailable here
    });

    const res = await request(app)
      .patch('/scheduled-tasks/seeded-per-run')
      .send({ prompt: 'after', sessionMode: 'per_run' });

    expect(res.status).toBe(200);
    const stored = await readCronTasks(h.workspace);
    expect(stored.find((t) => t.id === 'seeded-per-run')).toMatchObject({
      prompt: 'after',
      sessionMode: 'per_run',
    });

    // An actual conversion is still refused where dispatch is unavailable.
    await updateCronTasks(h.workspace, (tasks) => [
      ...tasks,
      {
        id: 'seeded-persistent',
        cron: '0 9 * * *',
        prompt: 'p',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: 1_700_000_000_000,
        sessionId: CALLER_SESSION_ID,
      },
    ]);
    const converted = await request(app)
      .patch('/scheduled-tasks/seeded-persistent')
      .send({ sessionMode: 'per_run' });
    expect(converted.status).toBe(409);
    expect(converted.body.code).toBe('session_mode_unavailable');
  });

  it('creates an unbound task without a bridge but rejects requested binding', async () => {
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

    const rejected = await request(app).post('/scheduled-tasks').send({
      cron: '0 10 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('session_binding_unavailable');

    const perRun = await request(app).post('/scheduled-tasks').send({
      cron: '0 11 * * *',
      prompt: 'p',
      sessionMode: 'per_run',
    });
    expect(perRun.status).toBe(409);
    expect(perRun.body.code).toBe('session_mode_unavailable');
  });

  it('rejects requested binding when management is off even with an active runtime bridge', async () => {
    // Mirrors the production createServeApp wiring exactly: getRuntime is
    // always wired to the primary runtime (active, carrying a bridge), while
    // deps `bridge` is undefined because manageScheduledTaskSessions is off.
    // The runtime bridge must NOT re-enable session binding in that case —
    // nothing would keep the bound session resident or rehydrate it after a
    // daemon restart, so caller-session requests fail closed with 409.
    const runtimeBridge = makeStubBridge();
    const app = express();
    app.use(express.json());
    registerScheduledTasksRoutes(app, {
      boundWorkspace: h.workspace,
      mutate: () => (_req, _res, next) => next(),
      safeBody,
      // no deps bridge — resident task-session management is off
      getRuntime: () =>
        ({
          workspaceId: 'primary',
          workspaceCwd: h.workspace,
          primary: true,
          trusted: true,
          bridge: runtimeBridge,
        }) as unknown as WorkspaceRuntime,
    });

    const unbound = await request(app)
      .post('/scheduled-tasks')
      .send({ cron: '0 9 * * *', prompt: 'p' });
    expect(unbound.status).toBe(201);
    expect(unbound.body.sessionId).toBeNull(); // unbound — fires via shared owner
    expect(runtimeBridge.spawned).toEqual([]); // nothing was spawned

    const rejected = await request(app).post('/scheduled-tasks').send({
      cron: '0 10 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.code).toBe('session_binding_unavailable');
    expect(runtimeBridge.spawned).toEqual([]);
    // The rejected POST persisted nothing — only the unbound task remains.
    expect(await readCronTasks(h.workspace)).toEqual([
      expect.objectContaining({ id: unbound.body.id }),
    ]);
  });

  it('reuses a caller-owned session without minting or renaming it', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);

    const res = await create({
      name: 'Digest',
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe(CALLER_SESSION_ID);
    expect(h.bridge.spawned).toEqual([]);
    expect(h.bridge.persisted).toEqual([CALLER_SESSION_ID]);
    expect(h.bridge.named).toEqual([]);
    expect(await readCronTasks(h.workspace)).toEqual([
      expect.objectContaining({
        sessionId: CALLER_SESSION_ID,
        sessionOwnedByTask: false,
      }),
    ]);

    await request(h.app)
      .patch(`/scheduled-tasks/${res.body.id}`)
      .send({ name: 'Renamed task' })
      .expect(200);
    expect(h.bridge.named).toEqual([]);
  });

  it('fails closed when existing-session persistence is unavailable', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    delete (h.bridge as Partial<StubBridge>).ensureDefaultSessionPersisted;

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_binding_unavailable');
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('does not bind a task when the session transcript cannot be persisted', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    h.bridge.persistenceError = new Error('disk full');

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('session_persistence_failed');
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('returns 404 when the session disappears during persistence', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    h.bridge.ensureDefaultSessionPersisted = async (sessionId) => {
      h.bridge.liveSessions.delete(sessionId);
      throw new SessionNotFoundError(sessionId);
    };

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('returns 503 when the runtime generation closes during persistence', async () => {
    await teardown(h);
    let generationOpen = true;
    h = await makeHarness(true, {
      get closed() {
        return !generationOpen;
      },
      assertOpen() {
        if (!generationOpen) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {
        generationOpen = false;
      },
    });
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    h.bridge.ensureDefaultSessionPersisted = async () => {
      generationOpen = false;
      throw new Error('channel closed');
    };

    const res = await request(h.app).post('/scheduled-tasks').send({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('rejects invalid, missing, and busy caller sessions', async () => {
    const invalid = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: 'not-a-uuid',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_session_id');

    const missing = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: MISSING_SESSION_ID,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('session_not_found');

    addLiveSession(h.bridge, BUSY_SESSION_ID, h.workspace, { busy: true });
    const busy = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: BUSY_SESSION_ID,
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('session_busy');
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('rejects a pending interaction and ineligible session sources', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace, {
      pendingInteractionCount: 1,
    });
    const pending = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('session_busy');

    h.bridge.liveSessions.delete(CALLER_SESSION_ID);
    for (const [index, options] of [
      { parentSessionId: 'parent-1' },
      { sourceType: 'channel' },
      { sourceType: 'standalone' },
      { sourceType: 'live_voice' },
      { sourceType: 'unknown' },
      { sourceId: 'source-1' },
    ].entries()) {
      const sessionId = `10000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
      addLiveSession(h.bridge, sessionId, h.workspace, options);
      const response = await create({
        cron: '0 9 * * *',
        prompt: 'p',
        sessionId,
      });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('session_source_ineligible');
    }
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('allows the trusted cron-tool path to bind its active caller session', async () => {
    addLiveSession(h.bridge, BUSY_SESSION_ID, h.workspace, { busy: true });

    const task = await createScheduledTaskWithExistingSession(
      {
        workspaceCwd: h.workspace,
        runtimeBaseDir: h.scratch,
        bridge: h.bridge,
      },
      {
        sessionId: BUSY_SESSION_ID,
        cron: '0 9 * * *',
        prompt: 'continue',
        recurring: true,
      },
      { source: 'cron-tool', assertCallerPromptActive: () => undefined },
    );

    expect(task).toEqual(
      expect.objectContaining({
        sessionId: BUSY_SESSION_ID,
        sessionOwnedByTask: false,
      }),
    );
    expect(task.lastFiredAt).not.toBeNull();
    expect(task.lastFiredAt! % 60_000).toBe(0);
    expect(h.bridge.persisted).toEqual([]);
  });

  it('rechecks the exact caller prompt inside the task-file lock', async () => {
    addLiveSession(h.bridge, BUSY_SESSION_ID, h.workspace, { busy: true });
    let activePromptId = 'prompt-a';
    const assertCallerPromptActive = vi.fn(() => {
      if (activePromptId !== 'prompt-a') throw new Error('stale prompt');
      activePromptId = 'prompt-b';
    });

    await expect(
      createScheduledTaskWithExistingSession(
        {
          workspaceCwd: h.workspace,
          runtimeBaseDir: h.scratch,
          bridge: h.bridge,
        },
        {
          sessionId: BUSY_SESSION_ID,
          cron: '0 9 * * *',
          prompt: 'continue',
          recurring: true,
        },
        { source: 'cron-tool', assertCallerPromptActive },
      ),
    ).rejects.toThrow('stale prompt');
    expect(assertCallerPromptActive).toHaveBeenCalledTimes(2);
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('keeps pending interactions ineligible on the trusted cron-tool path', async () => {
    addLiveSession(h.bridge, BUSY_SESSION_ID, h.workspace, {
      busy: true,
      pendingInteractionCount: 1,
    });

    await expect(
      createScheduledTaskWithExistingSession(
        {
          workspaceCwd: h.workspace,
          runtimeBaseDir: h.scratch,
          bridge: h.bridge,
        },
        {
          sessionId: BUSY_SESSION_ID,
          cron: '0 9 * * *',
          prompt: 'continue',
          recurring: true,
        },
        { source: 'cron-tool', assertCallerPromptActive: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'session_busy' });
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('rejects sessions reserved for scheduled tasks', async () => {
    addLiveSession(h.bridge, OTHER_SESSION_ID, h.workspace, {
      sourceType: 'scheduled_task',
    });

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: OTHER_SESSION_ID,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_already_bound');
    expect(await readCronTasks(h.workspace)).toEqual([]);
  });

  it('rejects a session already bound to another task', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    await updateCronTasks(h.workspace, (tasks) => [
      ...tasks,
      {
        id: 'existing-task',
        cron: '0 9 * * *',
        prompt: 'existing',
        recurring: true,
        createdAt: 1_700_000_000_000,
        lastFiredAt: 1_700_000_000_000,
        sessionId: CALLER_SESSION_ID,
      },
    ]);

    const res = await create({
      cron: '0 10 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('session_already_bound');
    expect(await readCronTasks(h.workspace)).toHaveLength(1);
  });

  it('binds a caller session at most once across concurrent creates', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);

    const responses = await Promise.all([
      create({
        cron: '0 9 * * *',
        prompt: 'p',
        sessionId: CALLER_SESSION_ID,
      }),
      create({
        cron: '0 10 * * *',
        prompt: 'q',
        sessionId: CALLER_SESSION_ID,
      }),
    ]);

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(responses.find((res) => res.status === 409)?.body.code).toBe(
      'session_already_bound',
    );
    expect(await readCronTasks(h.workspace)).toHaveLength(1);
  });

  it('leaves the caller session open when the task write fails', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'CORRUPT {{{', 'utf8');

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('scheduled_tasks_write_failed');
    expect(h.bridge.closed).toEqual([]);
    expect(h.cleanupSession).not.toHaveBeenCalled();
  });

  it('fails cleanly when the session disappears before commit', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    const getSummary = h.bridge.getSessionSummary.bind(h.bridge);
    let calls = 0;
    h.bridge.getSessionSummary = (sessionId) => {
      calls += 1;
      if (calls === 2) throw new SessionNotFoundError(sessionId);
      return getSummary(sessionId);
    };

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
    expect(await readCronTasks(h.workspace)).toEqual([]);
    expect(h.bridge.closed).toEqual([]);
  });

  it('returns 500 when session lookup fails unexpectedly', async () => {
    h.bridge.getSessionSummary = () => {
      throw new Error('lookup failed');
    };

    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('scheduled_tasks_session_failed');
    expect(await readCronTasks(h.workspace)).toEqual([]);
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
      { sessionId: named.body.sessionId, displayName: 'Digest' },
    ]);

    const unnamed = await create({ cron: '0 9 * * *', prompt: 'do the thing' });
    expect(h.bridge.named[1]).toEqual({
      sessionId: unnamed.body.sessionId,
      displayName: 'do the thing',
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
      // The persisted removal changes the catalog, so the catalog clock must
      // advance with it.
      expect(h.bridge.markSessionCatalogChanged).toHaveBeenCalledTimes(1);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('does not mark the catalog when the rollback removal is a no-op', async () => {
    // Same failure shape as the rollback test above, but the persisted session
    // is already gone — a no-op removal carries no catalog change and must not
    // advance the version.
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, 'CORRUPT {{{', 'utf8');
    const removeSpy = vi
      .spyOn(SessionService.prototype, 'removeSession')
      .mockResolvedValue(false);
    try {
      const res = await create({ cron: '0 9 * * *', prompt: 'p' });
      expect(res.status).toBe(500);
      expect(h.bridge.closed).toEqual([h.bridge.spawned[0]]);
      expect(h.bridge.markSessionCatalogChanged).not.toHaveBeenCalled();
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

  it('preserves a missing PATCH response when no mutation committed', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness(true, {
      closed: false,
      assertOpen() {
        checks += 1;
        if (checks > 1) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {},
    });

    const res = await request(h.app)
      .patch('/scheduled-tasks/missing1')
      .send({ enabled: false });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
    expect(checks).toBe(1);
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

  it('keeps a caller-owned session open when its task is deleted', async () => {
    addLiveSession(h.bridge, CALLER_SESSION_ID, h.workspace);
    const created = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    const deleted = await request(h.app).delete(
      `/scheduled-tasks/${created.body.id}`,
    );

    expect(deleted.status).toBe(200);
    expect(await readCronTasks(h.workspace)).toEqual([]);
    expect(h.bridge.closed).toEqual([]);
    expect(h.bridge.getSessionSummary(CALLER_SESSION_ID).sessionId).toBe(
      CALLER_SESSION_ID,
    );
  });

  it('preserves a missing DELETE response when no mutation committed', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness(true, {
      closed: false,
      assertOpen() {
        checks += 1;
        if (checks > 1) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {},
    });

    const res = await request(h.app).delete('/scheduled-tasks/missing1');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('task_not_found');
    expect(checks).toBe(1);
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

  it('reports a legacy guarded task (still-on-disk `condition`) as disabled on GET, fail-closed', async () => {
    // A task written by a pre-removal version as an isolated run with a
    // `condition` precondition — the field is no longer part of DurableCronTask,
    // so it lives on disk as an unknown key (isValidTask ignores it). Even
    // though its on-disk `enabled` is true, the REST list must fail it CLOSED:
    // reported disabled with no next-run, so the management UI never shows it
    // active or offers a Run affordance for a task the scheduler refuses to fire.
    await seedTask({
      id: 'legacy-guard',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: true,
      sessionId: 'sess-legacy-guard',
      condition: 'only when files changed',
    });
    // A normal enabled task, appended alongside, for contrast.
    const normal = await create({ cron: '0 9 * * *', prompt: 'ok' });
    expect(normal.status).toBe(201);

    const res = await request(h.app).get('/scheduled-tasks');
    expect(res.status).toBe(200);
    const legacy = res.body.tasks.find(
      (t: { id: string }) => t.id === 'legacy-guard',
    );
    expect(legacy.enabled).toBe(false); // fail-closed despite on-disk enabled:true
    expect(legacy.nextRunAt).toBeNull(); // no next-run advertised
    // The ordinary task is unaffected — enabled with a real next-run.
    const ok = res.body.tasks.find(
      (t: { id: string }) => t.id === normal.body.id,
    );
    expect(ok.enabled).toBe(true);
    expect(typeof ok.nextRunAt).toBe('number');
  });

  it('refuses a manual run for a legacy guarded task (409 task_legacy_unsupported, no record)', async () => {
    // The direct `/run` path is a second fail-closed guard: the task's on-disk
    // `enabled` may still be true, so the disabled check is not enough. Running
    // it here would execute the prompt with its removed safety gate ignored.
    await seedTask({
      id: 'legacy-run',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: true,
      sessionId: 'sess-legacy-run',
      condition: 'only when files changed',
    });
    const res = await request(h.app).post('/scheduled-tasks/legacy-run/run');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('task_legacy_unsupported');
    // The message points at re-creating the task / the create_sub_session path.
    expect(res.body.error).toContain('create_sub_session');
    // No phantom run recorded and lastFiredAt untouched.
    const list = await request(h.app).get('/scheduled-tasks');
    const t = list.body.tasks.find(
      (x: { id: string }) => x.id === 'legacy-run',
    );
    expect(t.runs).toEqual([]);
    expect(t.lastFiredAt).toBe(1_700_000_000_000);
  });

  it('preserves a no-write legacy rejection when the generation closes', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness(true, {
      closed: false,
      assertOpen() {
        checks += 1;
        if (checks > 1) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {},
    });
    await seedTask({
      id: 'legacy-run',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: true,
      sessionId: 'sess-legacy-run',
      condition: 'only when files changed',
    });

    const res = await request(h.app).post('/scheduled-tasks/legacy-run/run');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('task_legacy_unsupported');
    expect(checks).toBe(1);
  });

  it('refuses to enable a legacy guarded task via PATCH (409 task_legacy_unsupported)', async () => {
    // `toView` reports the task disabled, so the only PATCH the UI sends is the
    // Enable toggle. Accepting it (200) would read back disabled again — an
    // Enable control that can never succeed with no error. Reject it instead.
    await seedTask({
      id: 'legacy-enable',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: null,
      enabled: false,
      sessionId: 'sess-legacy-enable',
      condition: 'only when files changed',
    });
    const res = await request(h.app)
      .patch('/scheduled-tasks/legacy-enable')
      .send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('task_legacy_unsupported');
    // The task stays disabled on disk (no write) and still reads back disabled.
    const list = await request(h.app).get('/scheduled-tasks');
    const t = list.body.tasks.find(
      (x: { id: string }) => x.id === 'legacy-enable',
    );
    expect(t.enabled).toBe(false);
  });

  it('preserves a legacy PATCH rejection when no mutation committed', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness(true, {
      closed: false,
      assertOpen() {
        checks += 1;
        if (checks > 1) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {},
    });
    await seedTask({
      id: 'legacy-enable',
      cron: '0 9 * * *',
      prompt: 'p',
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: null,
      enabled: false,
      sessionId: 'sess-legacy-enable',
      condition: 'only when files changed',
    });

    const res = await request(h.app)
      .patch('/scheduled-tasks/legacy-enable')
      .send({ enabled: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('task_legacy_unsupported');
    expect(checks).toBe(1);
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

  it('revokes channel delivery when a manual run consumes a one-shot task', async () => {
    const delivery = {
      kind: 'channel',
      target: {
        channelName: 'dingtalk',
        type: 'user' as const,
        id: 'user-1',
      },
    };
    const created = await create({
      cron: '0 9 1 1 *',
      prompt: 'p',
      recurring: false,
      delivery,
    });

    const res = await request(h.app).post(
      `/scheduled-tasks/${created.body.id}/run`,
    );

    expect(res.status).toBe(200);
    const firedAt = res.body.lastFiredAt + 60_000;
    expect(
      h.channelDeliveryAuthorizations.consume(h.workspace, {
        sessionId: created.body.sessionId,
        deliveryId: `${created.body.id}:${firedAt}`,
        source: 'scheduled',
        taskId: created.body.id,
        firedAt,
        target: delivery.target,
      }),
    ).toBe(false);
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

  it('preserves a concurrent max-tasks response when no mutation committed', async () => {
    await teardown(h);
    let checks = 0;
    h = await makeHarness(true, {
      closed: false,
      assertOpen() {
        checks += 1;
        if (checks > 3) {
          throw Object.assign(new Error('generation closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
      close() {},
    });
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tasks = Array.from({ length: 49 }, (_, index) => ({
      id: `task-${index}`,
      cron: '0 9 * * *',
      prompt: `prompt-${index}`,
      recurring: true,
      createdAt: 1_700_000_000_000,
      lastFiredAt: 1_700_000_000_000,
      enabled: true,
    }));
    await fsp.writeFile(file, JSON.stringify(tasks), 'utf8');
    const spawnOrAttach = h.bridge.spawnOrAttach;
    h.bridge.spawnOrAttach = async (req) => {
      const session = await spawnOrAttach(req);
      await fsp.writeFile(
        file,
        JSON.stringify([
          ...tasks,
          {
            id: 'concurrent-task',
            cron: '0 9 * * *',
            prompt: 'concurrent prompt',
            recurring: true,
            createdAt: 1_700_000_000_000,
            lastFiredAt: 1_700_000_000_000,
            enabled: true,
          },
        ]),
        'utf8',
      );
      return session;
    };

    const res = await create({ cron: '0 9 * * *', prompt: 'overflow' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('max_tasks_reached');
    expect(checks).toBe(3);
    expect(h.bridge.spawned).toEqual(['sess-1']);
    expect(h.bridge.closed).toEqual(['sess-1']);
    const stored = await readCronTasks(h.workspace);
    expect(stored).toHaveLength(50);
    expect(stored.at(-1)?.id).toBe('concurrent-task');
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
    expect(h.bridge.named).toEqual([{ sessionId: sid, displayName: 'Old' }]);

    // Renaming the task re-labels its session.
    const rename = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ name: 'New' });
    expect(rename.status).toBe(200);
    expect(h.bridge.named).toContainEqual({
      sessionId: sid,
      displayName: 'New',
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
      displayName: 'p',
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

  it('rejects a POST carrying the removed `runMode` field (400 unsupported_field, nothing created)', async () => {
    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      runMode: 'isolated',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_field');
    // The message names the field and points to the create_sub_session path.
    expect(res.body.error).toContain('runMode');
    expect(res.body.error).toContain('create_sub_session');
    // The task must not land on disk, and no session is spawned for it.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toEqual([]);
    expect(h.bridge.spawned).toEqual([]);
  });

  it('rejects a POST carrying the removed `condition` field (400 unsupported_field, nothing created)', async () => {
    const res = await create({
      cron: '0 9 * * *',
      prompt: 'p',
      condition: 'only when files changed',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unsupported_field');
    expect(res.body.error).toContain('condition');
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks).toEqual([]);
    expect(h.bridge.spawned).toEqual([]);
  });

  it('rejects a PATCH carrying the removed `runMode` field (400 unsupported_field, task unchanged)', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'orig' });
    const id = created.body.id as string;

    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ prompt: 'updated', runMode: 'isolated' });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('unsupported_field');
    expect(patch.body.error).toContain('runMode');

    // The rejected PATCH must not have mutated the stored task.
    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].prompt).toBe('orig');
  });

  it('rejects a PATCH carrying the removed `condition` field (400 unsupported_field, task unchanged)', async () => {
    const created = await create({ cron: '0 9 * * *', prompt: 'orig' });
    const id = created.body.id as string;

    const patch = await request(h.app)
      .patch(`/scheduled-tasks/${id}`)
      .send({ prompt: 'updated', condition: 'x' });
    expect(patch.status).toBe(400);
    expect(patch.body.code).toBe('unsupported_field');
    expect(patch.body.error).toContain('condition');

    const list = await request(h.app).get('/scheduled-tasks');
    expect(list.body.tasks[0].prompt).toBe('orig');
  });

  // Seeds the on-disk file directly so a task can carry a real prior fire.
  const seedTask = async (task: Record<string, unknown>) => {
    const file = getCronFilePath(h.workspace);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify([task]), 'utf8');
  };

  const staleMutationTask = () => ({
    id: 'stale-task',
    cron: '0 9 * * *',
    prompt: 'original',
    recurring: true,
    createdAt: 1_700_000_000_000,
    lastFiredAt: 1_700_000_000_000,
    enabled: true,
    sessionId: 'stale-session',
  });

  it('rolls back a PATCH that commits while the generation closes', async () => {
    await teardown(h);
    h = await makeHarness(true, closeGenerationDuringCronCommit());
    const original = staleMutationTask();
    await seedTask(original);

    const res = await request(h.app)
      .patch('/scheduled-tasks/stale-task')
      .send({ prompt: 'stale update' });

    expect(res.status).toBe(503);
    expect(await readCronTasks(h.workspace)).toEqual([original]);
  });

  it('rolls back a DELETE that commits while the generation closes', async () => {
    await teardown(h);
    h = await makeHarness(true, closeGenerationDuringCronCommit());
    const original = staleMutationTask();
    await seedTask(original);

    const res = await request(h.app).delete('/scheduled-tasks/stale-task');

    expect(res.status).toBe(503);
    expect(await readCronTasks(h.workspace)).toEqual([original]);
    expect(h.bridge.closed).toEqual([]);
  });

  it('rolls back a manual run that commits while the generation closes', async () => {
    await teardown(h);
    h = await makeHarness(true, closeGenerationDuringCronCommit());
    const original = staleMutationTask();
    await seedTask(original);

    const res = await request(h.app).post('/scheduled-tasks/stale-task/run');

    expect(res.status).toBe(503);
    expect(await readCronTasks(h.workspace)).toEqual([original]);
  });

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

  it('re-enabling a one-shot task re-seats its anchor (not fired as missed + deleted)', async () => {
    // A one-shot paused past its slot then re-enabled must fire at its NEXT
    // occurrence, not be read as a missed one-shot on the next reload and
    // silently deleted.
    const createdAt = 1_700_000_000_000; // long past
    await seedTask({
      id: 'o1',
      cron: '0 9 1 1 *',
      prompt: 'p',
      recurring: false,
      createdAt,
      lastFiredAt: createdAt,
      enabled: false,
    });
    const now = Date.now();
    const patch = await request(h.app)
      .patch('/scheduled-tasks/o1')
      .send({ enabled: true });
    expect(patch.status).toBe(200);
    expect(patch.body.createdAt).toBeGreaterThanOrEqual(now - 5_000); // re-seated
    expect(patch.body.nextRunAt).toBeGreaterThan(now); // fires at NEXT occurrence
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
  it('keeps the title flat and collapses whitespace', () => {
    expect(scheduledTaskSessionName('  Daily   digest ')).toBe('Daily digest');
  });

  it('strips terminal control sequences (else the bridge guard drops the rename)', () => {
    // The CSI sequence is flattened to a space (and collapsed), leaving no
    // control char to trip the bridge's title guard.
    const name = scheduledTaskSessionName('ab\x1b[31mc');
    expect(name).toBe('ab c');
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

  it('strips Unicode bidi override/isolate chars (Trojan-Source reordering defense)', () => {
    // The bridge's title guard only rejects C0/DEL, so bidi controls (all
    // > 0x9f) slip through and would visually reorder the label in renderers
    // that honor bidi. Inputs are built from code points so this test file
    // itself carries no reordering controls.
    const RLO = String.fromCodePoint(0x202e); // right-to-left override
    expect(scheduledTaskSessionName(`inv${RLO}fdp.exe`)).toBe('invfdp.exe');
    // Every isolate (U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI) too.
    const isolates = [0x2066, 0x2067, 0x2068, 0x2069]
      .map((c) => String.fromCodePoint(c))
      .join('');
    expect(scheduledTaskSessionName(`a${isolates}b`)).toBe('ab');
    // And the remaining embedding/override chars (U+202A-U+202D).
    const embeds = [0x202a, 0x202b, 0x202c, 0x202d]
      .map((c) => String.fromCodePoint(c))
      .join('');
    expect(scheduledTaskSessionName(`x${embeds}y`)).toBe('xy');
    // And the standalone directional marks (U+061C ALM, U+200E LRM, U+200F RLM),
    // which are also Bidi_Control but invisible rather than reordering.
    const marks = [0x061c, 0x200e, 0x200f]
      .map((c) => String.fromCodePoint(c))
      .join('');
    expect(scheduledTaskSessionName(`m${marks}n`)).toBe('mn');
  });
});

// ── Workspace-qualified routes ──────────────────────────────────────────────

interface QualifiedRuntime {
  workspaceId: string;
  workspaceCwd: string;
  sessionRuntimeBaseDir: string;
  trusted: boolean;
  provenance?: 'existing' | 'live-conversation';
  bridge: StubBridge;
}

interface QualifiedHarness {
  app: express.Application;
  scratch: string;
  primary: QualifiedRuntime;
  secondary: QualifiedRuntime;
  untrusted: QualifiedRuntime;
  activity: ConversationRuntimeActivityGate;
  workspaceRegistry: WorkspaceRegistry;
}

/** A registry stub exposing only what the qualified route resolver touches:
 * lookup by id, lookup by cwd, and list (for the mismatch fallback). */
function makeStubRegistry(runtimes: QualifiedRuntime[]): WorkspaceRegistry {
  const asRuntime = (r: QualifiedRuntime) => r as unknown as WorkspaceRuntime;
  const entries = runtimes.map((runtime, index) => ({
    workspaceId: runtime.workspaceId,
    workspaceCwd: runtime.workspaceCwd,
    primary: index === 0,
    removable: index !== 0,
    get internal() {
      return runtime.provenance === 'live-conversation';
    },
    registrationIds: [],
    lastGenerationId: 1,
    state: 'active' as const,
    current: {
      generationId: 1,
      policyRevision: 'test',
      runtime: asRuntime(runtime),
      guard: {
        closed: false,
        assertOpen: () => {},
        close: () => {},
      },
    },
    configuredRevision: 'test',
    appliedRevision: 'test',
  }));
  return {
    list: () =>
      runtimes
        .filter((runtime) => runtime.provenance !== 'live-conversation')
        .map(asRuntime),
    listEntries: () => entries.filter((entry) => !entry.internal),
    listAll: () => runtimes.map(asRuntime),
    listAllEntries: () => entries,
    getEntryByWorkspaceId: (id: string) =>
      entries.find((entry) => entry.workspaceId === id),
    getEntryByWorkspaceCwd: (cwd: string) =>
      entries.find((entry) => entry.workspaceCwd === cwd),
    getManagedEntryByWorkspaceId: (id: string) =>
      entries.find((entry) => entry.workspaceId === id),
    getManagedEntryByWorkspaceCwd: (cwd: string) =>
      entries.find((entry) => entry.workspaceCwd === cwd),
    getByWorkspaceId: (id: string) => {
      const found = runtimes.find((r) => r.workspaceId === id);
      return found?.provenance === 'live-conversation'
        ? undefined
        : found
          ? asRuntime(found)
          : undefined;
    },
    getByWorkspaceCwd: (cwd: string) => {
      const found = runtimes.find((r) => r.workspaceCwd === cwd);
      return found?.provenance === 'live-conversation'
        ? undefined
        : found
          ? asRuntime(found)
          : undefined;
    },
    getManagedByWorkspaceId: (id: string) => {
      const found = runtimes.find((runtime) => runtime.workspaceId === id);
      return found ? asRuntime(found) : undefined;
    },
    getManagedByWorkspaceCwd: (cwd: string) => {
      const found = runtimes.find((runtime) => runtime.workspaceCwd === cwd);
      return found ? asRuntime(found) : undefined;
    },
    resolveLiveSessionOwner: (sessionId: string) => {
      const matches = runtimes.filter((runtime) => {
        try {
          runtime.bridge.getSessionSummary(sessionId);
          return true;
        } catch (error) {
          if (error instanceof SessionNotFoundError) return false;
          throw error;
        }
      });
      if (matches.length === 0) return { kind: 'not_found' };
      if (matches.length === 1) {
        return { kind: 'found', runtime: asRuntime(matches[0]!) };
      }
      return { kind: 'ambiguous', runtimes: matches.map(asRuntime) };
    },
  } as unknown as WorkspaceRegistry;
}

async function makeQualifiedHarness(): Promise<QualifiedHarness> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'sched-wsq-'));
  Storage.setRuntimeBaseDir(scratch);

  const mkRuntime = async (
    name: string,
    trusted: boolean,
  ): Promise<QualifiedRuntime> => {
    const workspaceCwd = path.join(scratch, name);
    await fsp.mkdir(workspaceCwd, { recursive: true });
    return {
      workspaceId: `id-${name}`,
      workspaceCwd,
      sessionRuntimeBaseDir: path.join(scratch, `runtime-${name}`),
      trusted,
      bridge: makeStubBridge(),
    };
  };

  const primary = await mkRuntime('primary', true);
  const secondary = await mkRuntime('secondary', true);
  const untrusted = await mkRuntime('untrusted', false);
  const runtimes = [primary, secondary, untrusted];
  const activity = new ConversationRuntimeActivityGate();
  const workspaceRegistry = makeStubRegistry(runtimes);

  const app = express();
  app.use(express.json());
  // Both surfaces share the app, as in the real server: the primary's own
  // cron file behind `/scheduled-tasks`, every workspace behind the qualified
  // route. `bridge`-per-runtime comes from the registry.
  registerScheduledTasksRoutes(app, {
    boundWorkspace: primary.workspaceCwd,
    mutate: () => (_req, _res, next) => next(),
    safeBody,
    bridge: primary.bridge,
    getRuntime: () => primary as unknown as WorkspaceRuntime,
    workspaceRegistry,
  });
  registerWorkspaceQualifiedScheduledTasksRoutes(app, {
    workspaceRegistry,
    mutate: () => (_req, _res, next) => next(),
    safeBody,
    manageScheduledTaskSessions: true,
    conversationRuntimeActivity: activity,
  });
  return {
    app,
    scratch,
    primary,
    secondary,
    untrusted,
    activity,
    workspaceRegistry,
  };
}

describe('workspace-qualified scheduled-tasks routes', () => {
  let h: QualifiedHarness;

  beforeEach(async () => {
    h = await makeQualifiedHarness();
  });
  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fsp.rm(h.scratch, { recursive: true, force: true });
  });

  const qualified = (id: string) => `/workspaces/${id}/scheduled-tasks`;
  const cronFilePath = (runtime: QualifiedRuntime) =>
    Storage.runWithResolvedRuntimeBaseDir(runtime.sessionRuntimeBaseDir, () =>
      getCronFilePath(runtime.workspaceCwd),
    );

  it('creates a task in the targeted workspace, isolated from the primary', async () => {
    const res = await request(h.app)
      .post(qualified(h.secondary.workspaceId))
      .send({ cron: '0 9 * * *', prompt: 'secondary work' });
    expect(res.status).toBe(201);
    // The bound session was minted through the SECONDARY workspace's bridge.
    expect(h.secondary.bridge.spawned).toHaveLength(1);
    expect(h.primary.bridge.spawned).toHaveLength(0);

    // It lands in the secondary's list, and NOT the primary's.
    const secList = await request(h.app).get(
      qualified(h.secondary.workspaceId),
    );
    expect(secList.body.tasks).toHaveLength(1);
    expect(secList.body.tasks[0].prompt).toBe('secondary work');
    const primaryList = await request(h.app).get('/scheduled-tasks');
    expect(primaryList.body.tasks).toHaveLength(0);
  });

  it('reuses a live-conversation session on the qualified endpoint', async () => {
    h.secondary.provenance = 'live-conversation';
    addLiveSession(
      h.secondary.bridge,
      SECONDARY_SESSION_ID,
      h.secondary.workspaceCwd,
    );

    const res = await request(h.app)
      .post(qualified(h.secondary.workspaceId))
      .send({
        cron: '0 9 * * *',
        prompt: 'p',
        sessionId: SECONDARY_SESSION_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe(SECONDARY_SESSION_ID);
    expect(h.secondary.bridge.spawned).toEqual([]);
  });

  it('rejects a foreign session on the primary endpoint', async () => {
    addLiveSession(
      h.secondary.bridge,
      SECONDARY_SESSION_ID,
      h.secondary.workspaceCwd,
    );

    const res = await request(h.app).post('/scheduled-tasks').send({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: SECONDARY_SESSION_ID,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('session_workspace_mismatch');
    expect(h.primary.bridge.spawned).toEqual([]);
  });

  it('rejects a session claimed by two runtimes as ambiguous', async () => {
    addLiveSession(
      h.primary.bridge,
      SECONDARY_SESSION_ID,
      h.primary.workspaceCwd,
    );
    addLiveSession(
      h.secondary.bridge,
      SECONDARY_SESSION_ID,
      h.secondary.workspaceCwd,
    );

    const res = await request(h.app).post('/scheduled-tasks').send({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: SECONDARY_SESSION_ID,
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('ambiguous_session_owner');
    expect(h.primary.bridge.spawned).toEqual([]);
    expect(h.secondary.bridge.spawned).toEqual([]);
  });

  it('maps owner lookup failures to a session error', async () => {
    h.workspaceRegistry.resolveLiveSessionOwner = () => {
      throw new Error('owner lookup failed');
    };

    const res = await request(h.app).post('/scheduled-tasks').send({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('scheduled_tasks_session_failed');
  });

  it('preserves the retry hint for an unavailable session owner', async () => {
    h.workspaceRegistry.resolveLiveSessionOwner = () => ({
      kind: 'unavailable',
    });

    const res = await request(h.app).post('/scheduled-tasks').send({
      cron: '0 9 * * *',
      prompt: 'p',
      sessionId: CALLER_SESSION_ID,
    });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('workspace_runtime_unavailable');
    expect(res.headers['retry-after']).toBe('1');
  });

  it('writes to the targeted workspace’s own cron file on disk', async () => {
    await request(h.app)
      .post(qualified(h.secondary.workspaceId))
      .send({ cron: '0 9 * * *', prompt: 'p' });
    const onDisk = JSON.parse(
      await fsp.readFile(cronFilePath(h.secondary), 'utf-8'),
    );
    expect(onDisk).toHaveLength(1);
    // Neither the primary runtime nor the process-global fallback was touched.
    await expect(
      fsp.readFile(cronFilePath(h.primary), 'utf-8'),
    ).rejects.toThrow();
    await expect(
      fsp.readFile(getCronFilePath(h.secondary.workspaceCwd), 'utf-8'),
    ).rejects.toThrow();
  });

  it('patches / runs / deletes a task addressed by its workspace', async () => {
    const created = await request(h.app)
      .post(qualified(h.secondary.workspaceId))
      .send({ cron: '0 9 * * *', prompt: 'p', name: 'orig' });
    const id = created.body.id as string;

    const patched = await request(h.app)
      .patch(`${qualified(h.secondary.workspaceId)}/${id}`)
      .send({ name: 'renamed' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('renamed');

    const ran = await request(h.app)
      .post(`${qualified(h.secondary.workspaceId)}/${id}/run`)
      .send();
    expect(ran.status).toBe(200);
    expect(ran.body.lastFiredAt).toBeGreaterThan(0);

    const del = await request(h.app)
      .delete(`${qualified(h.secondary.workspaceId)}/${id}`)
      .send();
    expect(del.status).toBe(200);
    const after = await request(h.app).get(qualified(h.secondary.workspaceId));
    expect(after.body.tasks).toHaveLength(0);
  });

  it('resolves a workspace by absolute path too', async () => {
    const res = await request(h.app)
      .post(qualified(encodeURIComponent(h.secondary.workspaceCwd)))
      .send({ cron: '0 9 * * *', prompt: 'via path' });
    expect(res.status).toBe(201);
    expect(h.secondary.bridge.spawned).toHaveLength(1);
  });

  it('rejects an unknown workspace with 400 workspace_mismatch', async () => {
    const res = await request(h.app).get(qualified('id-nope')).send();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('workspace_mismatch');
  });

  it('rejects an untrusted workspace with 403, without spawning', async () => {
    const res = await request(h.app)
      .post(qualified(h.untrusted.workspaceId))
      .send({ cron: '0 9 * * *', prompt: 'p' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('untrusted_workspace');
    expect(h.untrusted.bridge.spawned).toHaveLength(0);
  });

  it('rejects generic task creation in the Conversations workspace', async () => {
    h.secondary.provenance = 'live-conversation';

    const res = await request(h.app)
      .post(qualified(h.secondary.workspaceId))
      .send({ cron: '0 9 * * *', prompt: 'must not create a root session' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('live_session_creation_reserved');
    expect(h.secondary.bridge.spawned).toHaveLength(0);
    await expect(
      fsp.readFile(getCronFilePath(h.secondary.workspaceCwd), 'utf-8'),
    ).rejects.toThrow();
  });

  it('fails closed before internal task reads when the activity gate is absent', async () => {
    h.secondary.provenance = 'live-conversation';
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedScheduledTasksRoutes(app, {
      workspaceRegistry: makeStubRegistry([
        h.primary,
        h.secondary,
        h.untrusted,
      ]),
      mutate: () => (_req, _res, next) => next(),
      safeBody,
      manageScheduledTaskSessions: true,
    });

    const response = await request(app).get(qualified(h.secondary.workspaceId));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('conversation_runtime_unavailable');
  });

  it('holds the Conversations activity lease for the whole delete handler', async () => {
    const created = await request(h.app)
      .post(qualified(h.secondary.workspaceId))
      .send({ cron: '0 9 * * *', prompt: 'p' });
    const taskId = created.body.id as string;
    h.secondary.provenance = 'live-conversation';
    let finishClose: (() => void) | undefined;
    const closePending = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const originalClose = h.secondary.bridge.closeSession.bind(
      h.secondary.bridge,
    );
    vi.spyOn(h.secondary.bridge, 'closeSession').mockImplementation(
      async (sessionId) => {
        await originalClose(sessionId);
        await closePending;
      },
    );

    const deletion = request(h.app)
      .delete(`${qualified(h.secondary.workspaceId)}/${taskId}`)
      .then((response) => response);
    await vi.waitFor(() => expect(h.secondary.bridge.closed).toHaveLength(1));
    let drained = false;
    const drain = h.activity.sealAndWait().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishClose?.();
    expect((await deletion).status).toBe(200);
    await drain;
    expect(drained).toBe(true);

    const late = await request(h.app).get(qualified(h.secondary.workspaceId));
    expect(late.status).toBe(503);
    expect(late.body.code).toBe('daemon_draining');
  });
});
