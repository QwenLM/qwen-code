/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createMutationGate } from './auth.js';
import type {
  AcpSessionBridge,
  BridgeWorkspaceMemoryDreamResult,
  BridgeWorkspaceMemoryForgetRequest,
  BridgeWorkspaceMemoryForgetResult,
  BridgeWorkspaceMemoryRememberRequest,
  BridgeWorkspaceMemoryRememberResult,
} from './acp-session-bridge.js';
import { WorkspaceDrainingError } from './acp-session-bridge.js';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  mountWorkspaceMemoryRememberRoutes,
  WorkspaceRememberTaskLane,
  type WorkspaceRememberRouteDeps,
} from './workspace-remember.js';
import { MAX_REMEMBER_CONTENT_BYTES } from './workspace-memory-remember-constants.js';

const { mockDebugLogger } = vi.hoisted(() => ({
  mockDebugLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => mockDebugLogger,
}));

type RecordedEvent = Omit<BridgeEvent, 'id' | 'v'>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > 1000) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function buildBridgeStub(opts: {
  knownIds?: Iterable<string>;
  available?: boolean;
  availableImpl?: () => Promise<boolean>;
  rememberImpl?: (
    req: BridgeWorkspaceMemoryRememberRequest,
  ) => Promise<BridgeWorkspaceMemoryRememberResult>;
  forgetImpl?: (
    req: BridgeWorkspaceMemoryForgetRequest,
  ) => Promise<BridgeWorkspaceMemoryForgetResult>;
  dreamImpl?: () => Promise<BridgeWorkspaceMemoryDreamResult>;
  publishImpl?: (event: RecordedEvent) => void;
}): AcpSessionBridge & {
  events: RecordedEvent[];
  rememberCalls: BridgeWorkspaceMemoryRememberRequest[];
  forgetCalls: BridgeWorkspaceMemoryForgetRequest[];
  dreamCalls: number;
} {
  const events: RecordedEvent[] = [];
  const rememberCalls: BridgeWorkspaceMemoryRememberRequest[] = [];
  const forgetCalls: BridgeWorkspaceMemoryForgetRequest[] = [];
  let dreamCalls = 0;
  const known =
    opts.knownIds instanceof Set
      ? opts.knownIds
      : new Set<string>(opts.knownIds ?? []);
  const rememberImpl =
    opts.rememberImpl ??
    (async () => ({
      summary: 'saved',
      filesTouched: ['/mem/project/MEMORY.md'],
      touchedScopes: ['project'],
    }));
  const forgetImpl =
    opts.forgetImpl ??
    (async () => ({
      summary: 'forgot',
      removedEntries: [
        {
          topic: 'project',
          summary: 'old preference',
          filePath: '/mem/project/project.md',
        },
      ],
      touchedTopics: ['project'],
      touchedScopes: ['project'],
    }));
  const dreamImpl =
    opts.dreamImpl ??
    (async () => ({
      summary: 'dreamed',
      touchedTopics: ['project'],
      dedupedEntries: 1,
    }));

  return {
    events,
    rememberCalls,
    forgetCalls,
    get dreamCalls() {
      return dreamCalls;
    },
    publishWorkspaceEvent(event: RecordedEvent) {
      if (opts.publishImpl) {
        opts.publishImpl(event);
        return;
      }
      events.push(event);
    },
    knownClientIds() {
      return new Set(known);
    },
    async runWorkspaceMemoryRemember(
      req: BridgeWorkspaceMemoryRememberRequest,
    ) {
      rememberCalls.push(req);
      return rememberImpl(req);
    },
    async runWorkspaceMemoryForget(req: BridgeWorkspaceMemoryForgetRequest) {
      forgetCalls.push(req);
      return forgetImpl(req);
    },
    async runWorkspaceMemoryDream() {
      dreamCalls++;
      return dreamImpl();
    },
    async isWorkspaceMemoryRememberAvailable() {
      if (opts.availableImpl) return opts.availableImpl();
      return opts.available ?? true;
    },
    spawnOrAttach: () => {
      throw new Error('session path must not be used');
    },
    loadSession: () => {
      throw new Error('session path must not be used');
    },
    resumeSession: () => {
      throw new Error('session path must not be used');
    },
    sendPrompt: () => {
      throw new Error('session prompt path must not be used');
    },
    cancelSession: () => {
      throw new Error('not implemented');
    },
    subscribeEvents: () => {
      throw new Error('not implemented');
    },
    closeSession: () => {
      throw new Error('not implemented');
    },
    updateSessionMetadata: () => {
      throw new Error('not implemented');
    },
    respondToPermission: () => false,
    respondToSessionPermission: () => false,
    listWorkspaceSessions: () => [],
    getSessionSummary: () => {
      throw new Error('not implemented');
    },
    recordHeartbeat: () => {
      throw new Error('not implemented');
    },
    getHeartbeatState: () => undefined,
    queryWorkspaceStatus: async <T>(
      _method: string,
      idle: () => T,
    ): Promise<T> => idle(),
    invokeWorkspaceCommand: async () => {
      throw new Error('not implemented');
    },
    killSession: async () => true,
    detachClient: async () => {},
    sessionCount: 0,
    pendingPermissionCount: 0,
    killAllSync: () => {},
    shutdown: async () => {},
    preheat: async () => {},
  } as unknown as AcpSessionBridge & {
    events: RecordedEvent[];
    rememberCalls: BridgeWorkspaceMemoryRememberRequest[];
    forgetCalls: BridgeWorkspaceMemoryForgetRequest[];
    dreamCalls: number;
  };
}

function buildApp(
  bridge: AcpSessionBridge,
  auth: { tokenConfigured: boolean; requireAuth: boolean } = {
    tokenConfigured: true,
    requireAuth: false,
  },
  lane = new WorkspaceRememberTaskLane(bridge),
  routeOverrides: Partial<WorkspaceRememberRouteDeps> = {},
) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountWorkspaceMemoryRememberRoutes(app, {
    bridge,
    lane,
    mutate: createMutationGate(auth),
    parseClientId: (req, res) => {
      const raw = req.get('x-qwen-client-id');
      if (raw === undefined || raw === '') return undefined;
      if (raw.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
        res.status(400).json({
          error: '`X-Qwen-Client-Id` must be a non-empty token',
          code: 'invalid_client_id',
        });
        return null;
      }
      return raw;
    },
    safeBody: (req) => {
      const raw = req.body;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return Object.create(null) as Record<string, unknown>;
      }
      return raw as Record<string, unknown>;
    },
    ...routeOverrides,
  });
  return app;
}

describe('workspace memory remember routes', () => {
  it('queues and completes a hidden workspace remember task', async () => {
    const bridge = buildBridgeStub({ knownIds: ['client-1'] });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ content: 'Remember this', contextMode: 'clean' })
      .expect(202);

    expect(post.body).toMatchObject({
      status: 'queued',
      contextMode: 'clean',
    });
    const taskId = post.body.taskId as string;
    expect(taskId).toMatch(
      /^remember-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await waitFor(() => bridge.rememberCalls.length === 1);
    await waitFor(() => bridge.events.length === 1);

    const get = await request(app)
      .get(`/workspace/memory/remember/${taskId}`)
      .set('X-Qwen-Client-Id', 'client-1')
      .expect(200);
    expect(get.body).toMatchObject({
      taskId,
      status: 'completed',
      contextMode: 'clean',
      result: {
        summary: 'Memory update completed.',
        touchedScopes: ['project'],
      },
    });
    expect(bridge.rememberCalls[0]).toEqual({
      content: 'Remember this',
      contextMode: 'clean',
    });
    expect(bridge.events[0]).toMatchObject({
      type: 'memory_changed',
      originatorClientId: 'client-1',
      data: {
        scope: 'managed',
        source: 'workspace_memory_remember',
        taskId,
        touchedScopes: ['project'],
      },
    });
  });

  it('queues and completes a hidden workspace forget task', async () => {
    const bridge = buildBridgeStub({
      knownIds: ['client-1'],
      forgetImpl: vi.fn(
        async (): Promise<BridgeWorkspaceMemoryForgetResult> => ({
          summary: 'forgot',
          removedEntries: [
            {
              topic: 'user',
              summary: 'old preference',
              filePath: '/mem/user/user.md',
            },
          ],
          touchedTopics: ['user', 'reference'],
          touchedScopes: ['user'],
        }),
      ),
    });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/forget')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ query: 'old preference' })
      .expect(202);

    const taskId = post.body.taskId as string;
    expect(taskId).toMatch(/^forget-/);
    await waitFor(() => bridge.forgetCalls.length === 1);
    await waitFor(() => bridge.events.length === 1);

    const get = await request(app)
      .get(`/workspace/memory/forget/${taskId}`)
      .set('X-Qwen-Client-Id', 'client-1')
      .expect(200);
    expect(get.body).toMatchObject({
      taskId,
      status: 'completed',
      result: {
        summary: 'forgot',
        touchedTopics: ['user', 'reference'],
        touchedScopes: ['user'],
        removedEntries: [
          {
            topic: 'user',
            summary: 'old preference',
            filePath: '/mem/user/user.md',
          },
        ],
      },
    });
    expect(bridge.forgetCalls[0]).toEqual({ query: 'old preference' });
    expect(bridge.events[0]).toMatchObject({
      type: 'memory_changed',
      originatorClientId: 'client-1',
      data: {
        scope: 'managed',
        source: 'workspace_memory_forget',
        taskId,
        touchedScopes: ['user'],
      },
    });
  });

  it('queues and completes a hidden workspace dream task', async () => {
    const bridge = buildBridgeStub({
      knownIds: ['client-1'],
      dreamImpl: vi.fn(
        async (): Promise<BridgeWorkspaceMemoryDreamResult> => ({
          summary: 'dreamed',
          touchedTopics: ['feedback', 'project'],
          dedupedEntries: 1,
        }),
      ),
    });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/dream')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({})
      .expect(202);

    const taskId = post.body.taskId as string;
    expect(taskId).toMatch(/^dream-/);
    await waitFor(() => bridge.dreamCalls === 1);
    await waitFor(() => bridge.events.length === 1);

    const get = await request(app)
      .get(`/workspace/memory/dream/${taskId}`)
      .set('X-Qwen-Client-Id', 'client-1')
      .expect(200);
    expect(get.body).toMatchObject({
      taskId,
      status: 'completed',
      result: {
        summary: 'dreamed',
        touchedTopics: ['feedback', 'project'],
        dedupedEntries: 1,
      },
    });
    expect(bridge.events[0]).toMatchObject({
      type: 'memory_changed',
      originatorClientId: 'client-1',
      data: {
        scope: 'managed',
        source: 'workspace_memory_dream',
        taskId,
        touchedScopes: ['user', 'project'],
      },
    });
  });

  it('requires auth for task polling', async () => {
    const bridge = buildBridgeStub({});
    const app = buildApp(bridge, {
      tokenConfigured: false,
      requireAuth: false,
    });

    await request(app)
      .get('/workspace/memory/remember/remember-test')
      .expect(401)
      .expect((res) => {
        expect(res.body.code).toBe('token_required');
      });
  });

  it('validates content, contextMode, client id, and unknown task ids', async () => {
    const bridge = buildBridgeStub({ knownIds: ['known'] });
    const app = buildApp(bridge);

    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: '   ' })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_content'));
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'x'.repeat(64 * 1024 + 1) })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_content'));
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: ` ${'x'.repeat(MAX_REMEMBER_CONTENT_BYTES)} ` })
      .expect(202);
    await waitFor(() => bridge.rememberCalls.length === 1);
    expect(bridge.rememberCalls[0]?.content).toBe(
      'x'.repeat(MAX_REMEMBER_CONTENT_BYTES),
    );
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'x', contextMode: 'thread' })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_context_mode'));
    await request(app)
      .post('/workspace/memory/remember')
      .set('X-Qwen-Client-Id', 'missing')
      .send({ content: 'x' })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_client_id'));
    await request(app)
      .get('/workspace/memory/remember/remember-missing')
      .expect(404)
      .expect((res) => expect(res.body.code).toBe('remember_task_not_found'));
    await request(app)
      .post('/workspace/memory/forget')
      .send({ query: '   ' })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_query'));
    await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'x'.repeat(MAX_REMEMBER_CONTENT_BYTES + 1) })
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_query'));
    await request(app)
      .get('/workspace/memory/forget/forget-missing')
      .expect(404)
      .expect((res) => expect(res.body.code).toBe('forget_task_not_found'));
    await request(app)
      .get('/workspace/memory/dream/dream-missing')
      .expect(404)
      .expect((res) => expect(res.body.code).toBe('dream_task_not_found'));
    await request(app)
      .get('/workspace/memory/remember/remember-missing')
      .set('X-Qwen-Client-Id', 'missing')
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_client_id'));
  });

  it('does not expose client-owned task status to other clients', async () => {
    const bridge = buildBridgeStub({ knownIds: ['client-1', 'client-2'] });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ content: 'Remember this' })
      .expect(202);
    const taskId = post.body.taskId as string;

    await request(app).get(`/workspace/memory/remember/${taskId}`).expect(404);
    await request(app)
      .get(`/workspace/memory/remember/${taskId}`)
      .set('X-Qwen-Client-Id', 'client-2')
      .expect(404);
    await request(app)
      .get(`/workspace/memory/remember/${taskId}`)
      .set('X-Qwen-Client-Id', 'client-1')
      .expect(200);
  });

  it('does not expose clientless task status to registered clients', async () => {
    const bridge = buildBridgeStub({ knownIds: ['client-1'] });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'Remember this' })
      .expect(202);
    const taskId = post.body.taskId as string;

    await request(app)
      .get(`/workspace/memory/remember/${taskId}`)
      .set('X-Qwen-Client-Id', 'client-1')
      .expect(404);
    await request(app).get(`/workspace/memory/remember/${taskId}`).expect(200);
  });

  it('does not expose a task through a different memory task endpoint', async () => {
    const bridge = buildBridgeStub({});
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'old preference' })
      .expect(202);
    const taskId = post.body.taskId as string;

    await request(app).get(`/workspace/memory/remember/${taskId}`).expect(404);
    await request(app).get(`/workspace/memory/dream/${taskId}`).expect(404);
    await request(app).get(`/workspace/memory/forget/${taskId}`).expect(200);
  });

  it('rejects task polling after the client detaches', async () => {
    const knownIds = new Set(['client-1']);
    const bridge = buildBridgeStub({ knownIds });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ content: 'Remember this' })
      .expect(202);

    knownIds.clear();

    await request(app)
      .get(`/workspace/memory/remember/${post.body.taskId}`)
      .set('X-Qwen-Client-Id', 'client-1')
      .expect(400)
      .expect((res) => expect(res.body.code).toBe('invalid_client_id'));
  });

  it('rejects new tasks when the hidden remember queue is full', async () => {
    const pending = deferred<BridgeWorkspaceMemoryRememberResult>();
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(() => pending.promise),
    });
    const app = buildApp(bridge);

    for (let i = 0; i < 16; i++) {
      await request(app)
        .post('/workspace/memory/remember')
        .send({ content: `remember ${i}` })
        .expect(202);
    }
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'overflow' })
      .expect(429)
      .expect((res) => {
        expect(res.body.code).toBe('remember_queue_full');
      });

    pending.resolve({
      filesTouched: [],
      touchedScopes: [],
    });
  });

  it('reserves queue capacity for remember tasks when forget and dream burst', async () => {
    const pendingForget = deferred<BridgeWorkspaceMemoryForgetResult>();
    const bridge = buildBridgeStub({
      forgetImpl: vi.fn(() => pendingForget.promise),
    });
    const app = buildApp(bridge);

    for (let i = 0; i < 8; i++) {
      await request(app)
        .post('/workspace/memory/forget')
        .send({ query: `forget ${i}` })
        .expect(202);
    }

    await request(app).post('/workspace/memory/dream').send({}).expect(429);
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember still has capacity' })
      .expect(202);

    pendingForget.resolve({
      removedEntries: [],
      touchedTopics: [],
      touchedScopes: [],
    });
  });

  it('evicts terminal tasks after the TTL when new tasks are queued', async () => {
    const bridge = buildBridgeStub({});
    const lane = new WorkspaceRememberTaskLane(bridge);
    const first = lane.enqueue({
      content: 'old remember',
      contextMode: 'workspace',
    });
    await waitFor(() => lane.get(first.taskId)?.status === 'completed');

    const internalLane = lane as unknown as {
      tasks: Map<string, { updatedAt: string }>;
    };
    const firstRecord = internalLane.tasks.get(first.taskId);
    expect(firstRecord).toBeDefined();
    firstRecord!.updatedAt = new Date(Date.now() - 6 * 60_000).toISOString();

    expect(lane.get(first.taskId)).toBeDefined();
    lane.enqueue({
      content: 'fresh remember',
      contextMode: 'workspace',
    });

    expect(lane.get(first.taskId)).toBeUndefined();
  });

  it('rolls back the enqueue gate and fails queued tasks on disposal', async () => {
    const first = deferred<BridgeWorkspaceMemoryRememberResult>();
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(async () => first.promise),
    });
    const lane = new WorkspaceRememberTaskLane(bridge, '/work/remove-me');
    const running = lane.enqueue({
      content: 'running',
      contextMode: 'workspace',
    });
    const queued = lane.enqueue({
      content: 'queued',
      contextMode: 'workspace',
    });
    await waitFor(() => lane.get(running.taskId)?.status === 'running');

    lane.beginDrain();
    expect(() =>
      lane.enqueue({ content: 'blocked', contextMode: 'workspace' }),
    ).toThrow(WorkspaceDrainingError);
    lane.cancelDrain();
    const queuedAfterRollback = lane.enqueue({
      content: 'queued after rollback',
      contextMode: 'workspace',
    });

    lane.dispose();
    expect(lane.get(queued.taskId)).toMatchObject({
      status: 'failed',
      error: { code: 'workspace_removed' },
    });
    expect(lane.get(queuedAfterRollback.taskId)).toMatchObject({
      status: 'failed',
      error: { code: 'workspace_removed' },
    });
    expect(lane.pendingCount()).toBe(1);

    first.reject(new Error('bridge closed'));
    await waitFor(() => lane.get(running.taskId)?.status === 'failed');
    expect(lane.get(running.taskId)).toMatchObject({
      error: { code: 'workspace_removed' },
    });
    expect(bridge.events).toEqual([]);
    expect(bridge.rememberCalls.map((call) => call.content)).toEqual([
      'running',
    ]);
  });

  it('fails a successful bridge result that settles after disposal', async () => {
    const first = deferred<BridgeWorkspaceMemoryRememberResult>();
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(async () => first.promise),
    });
    const lane = new WorkspaceRememberTaskLane(bridge, '/work/remove-me');
    const running = lane.enqueue({
      content: 'running',
      contextMode: 'workspace',
    });
    await waitFor(() => lane.get(running.taskId)?.status === 'running');

    lane.dispose();
    first.resolve({ filesTouched: [], touchedScopes: [] });

    await waitFor(() => lane.get(running.taskId)?.status === 'failed');
    expect(lane.get(running.taskId)).toMatchObject({
      error: { code: 'workspace_removed' },
    });
    expect(bridge.events).toEqual([]);
  });

  it('does not run a queued task after its runtime generation closes', async () => {
    const first = deferred<BridgeWorkspaceMemoryRememberResult>();
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(async () => first.promise),
    });
    const lane = new WorkspaceRememberTaskLane(bridge);
    const running = lane.enqueue({
      content: 'running',
      contextMode: 'workspace',
    });
    let generationClosed = false;
    const queued = lane.enqueue({
      content: 'stale queued task',
      contextMode: 'workspace',
      assertGenerationOpen: () => {
        if (generationClosed) throw new Error('generation closed');
      },
    });
    await waitFor(() => lane.get(running.taskId)?.status === 'running');

    generationClosed = true;
    first.resolve({ filesTouched: [], touchedScopes: [] });

    await waitFor(() => lane.get(queued.taskId)?.status === 'failed');
    expect(bridge.rememberCalls.map((call) => call.content)).toEqual([
      'running',
    ]);
  });

  it('runs hidden remember tasks serially within the remember lane', async () => {
    const first = deferred<BridgeWorkspaceMemoryRememberResult>();
    const second = deferred<BridgeWorkspaceMemoryRememberResult>();
    const starts: string[] = [];
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(async (req) => {
        starts.push(req.content);
        return req.content === 'one' ? first.promise : second.promise;
      }),
    });
    const app = buildApp(bridge);

    const postOne = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'one' })
      .expect(202);
    const postTwo = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'two' })
      .expect(202);

    await waitFor(() => starts.length === 1);
    expect(starts).toEqual(['one']);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toEqual(['one']);

    first.resolve({
      summary: 'first',
      filesTouched: [],
      touchedScopes: [],
    });
    await waitFor(() => starts.length === 2);
    expect(starts).toEqual(['one', 'two']);

    second.resolve({
      summary: 'second',
      filesTouched: [],
      touchedScopes: [],
    });

    await request(app)
      .get(`/workspace/memory/remember/${postOne.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
    await request(app)
      .get(`/workspace/memory/remember/${postTwo.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
    expect(bridge.events).toHaveLength(0);
  });

  it('serializes remember, forget, and dream tasks in one lane', async () => {
    const remember = deferred<BridgeWorkspaceMemoryRememberResult>();
    const forget = deferred<BridgeWorkspaceMemoryForgetResult>();
    const dream = deferred<BridgeWorkspaceMemoryDreamResult>();
    const starts: string[] = [];
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(async () => {
        starts.push('remember');
        return remember.promise;
      }),
      forgetImpl: vi.fn(async () => {
        starts.push('forget');
        return forget.promise;
      }),
      dreamImpl: vi.fn(async () => {
        starts.push('dream');
        return dream.promise;
      }),
    });
    const app = buildApp(bridge);

    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember one' })
      .expect(202);
    await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'forget one' })
      .expect(202);
    await request(app).post('/workspace/memory/dream').send({}).expect(202);

    await waitFor(() => starts.length === 1);
    expect(starts).toEqual(['remember']);
    remember.resolve({ filesTouched: [], touchedScopes: [] });
    await waitFor(() => starts.length === 2);
    expect(starts).toEqual(['remember', 'forget']);
    forget.resolve({
      removedEntries: [],
      touchedTopics: [],
      touchedScopes: [],
    });
    await waitFor(() => starts.length === 3);
    expect(starts).toEqual(['remember', 'forget', 'dream']);
    dream.resolve({ touchedTopics: [], dedupedEntries: 0 });
  });

  it('does not publish memory_changed for no-op remember results', async () => {
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn(async () => ({
        summary: 'nothing to save',
        filesTouched: [],
        touchedScopes: [],
      })),
    });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'no-op' })
      .expect(202);

    await waitFor(() => bridge.rememberCalls.length === 1);
    await request(app)
      .get(`/workspace/memory/remember/${post.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
    expect(bridge.events).toHaveLength(0);
  });

  it('does not publish memory_changed for no-op forget or dream results', async () => {
    const bridge = buildBridgeStub({
      forgetImpl: vi.fn(async () => ({
        summary: 'nothing matched',
        removedEntries: [],
        touchedTopics: [],
        touchedScopes: [],
      })),
      dreamImpl: vi.fn(async () => ({
        summary: 'nothing changed',
        touchedTopics: [],
        dedupedEntries: 0,
      })),
    });
    const app = buildApp(bridge);

    const forgetPost = await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'missing' })
      .expect(202);
    const dreamPost = await request(app)
      .post('/workspace/memory/dream')
      .send({})
      .expect(202);

    await waitFor(() => bridge.forgetCalls.length === 1);
    await waitFor(() => bridge.dreamCalls === 1);
    await request(app)
      .get(`/workspace/memory/forget/${forgetPost.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
    await request(app)
      .get(`/workspace/memory/dream/${dreamPost.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
    expect(bridge.events).toHaveLength(0);
  });

  it('keeps the task completed when memory_changed publishing fails', async () => {
    const bridge = buildBridgeStub({
      publishImpl: vi.fn(() => {
        throw new Error('event bus failed');
      }),
    });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember this' })
      .expect(202);

    await waitFor(() => bridge.rememberCalls.length === 1);
    await request(app)
      .get(`/workspace/memory/remember/${post.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('completed');
        expect(res.body.error).toBeUndefined();
      });
  });

  it('returns 409 when managed memory is unavailable', async () => {
    const bridge = buildBridgeStub({
      available: false,
    });
    const app = buildApp(bridge);
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember me' })
      .expect(409)
      .expect((res) => {
        expect(res.body.code).toBe('managed_memory_unavailable');
      });
    expect(bridge.rememberCalls).toHaveLength(0);
  });

  it('returns kind-specific error codes when the availability check throws', async () => {
    const bridge = buildBridgeStub({
      availableImpl: vi.fn().mockRejectedValue(new Error('bridge closed')),
    });
    const app = buildApp(bridge);
    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember me' })
      .expect(500)
      .expect((res) => {
        expect(res.body.code).toBe('remember_failed');
      });
    await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'old preference' })
      .expect(500)
      .expect((res) => {
        expect(res.body.code).toBe('forget_failed');
      });
    await request(app)
      .post('/workspace/memory/dream')
      .send({})
      .expect(500)
      .expect((res) => {
        expect(res.body.code).toBe('dream_failed');
      });
    expect(bridge.rememberCalls).toHaveLength(0);
    expect(bridge.forgetCalls).toHaveLength(0);
    expect(bridge.dreamCalls).toBe(0);
  });

  it('returns runtime unavailable when the generation closes during availability checking', async () => {
    const availability = deferred<boolean>();
    const availableImpl = vi.fn(() => availability.promise);
    const bridge = buildBridgeStub({ availableImpl });
    let closed = false;
    const app = buildApp(bridge, undefined, undefined, {
      captureGenerationAssertion: () => () => {
        if (closed) {
          throw Object.assign(new Error('closed'), {
            code: 'workspace_generation_closed',
          });
        }
      },
    });
    const responsePromise = request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember me' })
      .then((response) => response);
    await waitFor(() => availableImpl.mock.calls.length === 1);
    closed = true;
    availability.reject(new Error('bridge closed'));

    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
  });

  it.each(['remember', 'forget', 'dream'])(
    'rejects untrusted %s task reads before task lookup',
    async (kind) => {
      const bridge = buildBridgeStub({});
      const app = buildApp(bridge, undefined, undefined, {
        isWorkspaceTrusted: () => false,
      });

      const response = await request(app).get(
        `/workspace/memory/${kind}/missing`,
      );

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('untrusted_workspace');
    },
  );

  it.each(['remember', 'forget', 'dream'])(
    'rejects closed-generation %s task reads before task lookup',
    async (kind) => {
      const bridge = buildBridgeStub({});
      const app = buildApp(bridge, undefined, undefined, {
        captureGenerationAssertion: () => () => {
          throw new Error('closed');
        },
      });

      const response = await request(app).get(
        `/workspace/memory/${kind}/missing`,
      );

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('workspace_runtime_unavailable');
    },
  );

  it('falls back to kind-specific codes when enqueue code extraction throws', async () => {
    mockDebugLogger.warn.mockClear();
    const bridge = buildBridgeStub({});
    const lane = new WorkspaceRememberTaskLane(bridge);
    const err = new Proxy(
      {},
      {
        get() {
          throw new Error('code getter failed');
        },
      },
    );
    vi.spyOn(lane, 'enqueue').mockImplementation(() => {
      throw err;
    });
    vi.spyOn(lane, 'enqueueForget').mockImplementation(() => {
      throw err;
    });
    vi.spyOn(lane, 'enqueueDream').mockImplementation(() => {
      throw err;
    });
    const app = buildApp(bridge, undefined, lane);

    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember me' })
      .expect(500)
      .expect((res) => {
        expect(res.body).toEqual({
          error: 'Workspace memory remember failed.',
          code: 'remember_failed',
        });
      });
    await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'old preference' })
      .expect(500)
      .expect((res) => {
        expect(res.body).toEqual({
          error: 'Workspace memory forget failed.',
          code: 'forget_failed',
        });
      });
    await request(app)
      .post('/workspace/memory/dream')
      .send({})
      .expect(500)
      .expect((res) => {
        expect(res.body).toEqual({
          error: 'Workspace memory dream failed.',
          code: 'dream_failed',
        });
      });
    expect(mockDebugLogger.warn).toHaveBeenCalledTimes(3);
    expect(mockDebugLogger.warn).toHaveBeenCalledWith(
      'Failed to extract workspace memory error code:',
      { extractionError: 'code getter failed' },
    );
  });

  it('maps a draining workspace to a stable 503 response', async () => {
    const bridge = buildBridgeStub({});
    const lane = new WorkspaceRememberTaskLane(bridge, '/work/draining');
    lane.beginDrain();
    const app = buildApp(bridge, undefined, lane);

    await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'remember me' })
      .expect(503)
      .expect((res) => {
        expect(res.body).toEqual({
          error: 'Workspace runtime is being removed.',
          code: 'workspace_draining',
        });
      });
  });

  it('records bridge failures with stable public error codes', async () => {
    const bridge = buildBridgeStub({
      rememberImpl: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('agent wrote /tmp/outside'), {
            code: 'remember_path_escape',
          }),
        )
        .mockRejectedValueOnce({
          data: { errorKind: 'managed_memory_unavailable' },
          message: 'internal managed memory config path',
        })
        .mockRejectedValueOnce({
          data: { errorKind: 'remember_timeout' },
        }),
    });
    const app = buildApp(bridge);

    const first = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'escape' })
      .expect(202);
    await waitFor(() => bridge.rememberCalls.length === 1);
    await request(app)
      .get(`/workspace/memory/remember/${first.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'remember_path_escape',
          message: 'Remember agent touched a path outside managed memory.',
          details: 'agent wrote /tmp/outside',
        });
      });

    const second = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'unavailable' })
      .expect(202);
    await waitFor(() => bridge.rememberCalls.length === 2);
    await request(app)
      .get(`/workspace/memory/remember/${second.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'managed_memory_unavailable',
          message: 'Managed memory is unavailable for this daemon workspace.',
        });
      });

    const third = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'timeout' })
      .expect(202);
    await waitFor(() => bridge.rememberCalls.length === 3);
    await request(app)
      .get(`/workspace/memory/remember/${third.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'remember_timeout',
          message: 'Workspace memory remember timed out.',
        });
      });
  });

  it('logs sanitized details for task-lane failures', async () => {
    mockDebugLogger.error.mockClear();
    const bridge = buildBridgeStub({
      rememberImpl: vi
        .fn()
        .mockRejectedValue(
          new Error('Authorization: Bearer secret-token-value'),
        ),
    });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'secret' })
      .expect(202);
    await waitFor(() => bridge.rememberCalls.length === 1);
    await request(app)
      .get(`/workspace/memory/remember/${post.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'remember_failed',
          message: 'Workspace memory remember failed.',
          details: 'Authorization: <redacted>',
        });
      });

    expect(mockDebugLogger.error).toHaveBeenCalledWith(
      'Workspace memory remember task failed:',
      expect.objectContaining({
        taskId: post.body.taskId,
        code: 'remember_failed',
        details: 'Authorization: <redacted>',
        stack: expect.stringContaining('Authorization: <redacted>'),
      }),
    );
    expect(JSON.stringify(mockDebugLogger.error.mock.calls)).not.toContain(
      'secret-token-value',
    );
  });

  it('falls back when task-lane error code extraction throws', async () => {
    mockDebugLogger.error.mockClear();
    mockDebugLogger.warn.mockClear();
    const err = new Proxy(
      {},
      {
        get() {
          throw new Error('code getter failed');
        },
      },
    );
    const bridge = buildBridgeStub({
      rememberImpl: vi.fn().mockRejectedValue(err),
    });
    const app = buildApp(bridge);

    const post = await request(app)
      .post('/workspace/memory/remember')
      .send({ content: 'proxy failure' })
      .expect(202);
    await waitFor(() => bridge.rememberCalls.length === 1);
    await request(app)
      .get(`/workspace/memory/remember/${post.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'remember_failed',
          message: 'Workspace memory remember failed.',
        });
      });

    expect(mockDebugLogger.warn).toHaveBeenCalledWith(
      'Failed to extract workspace memory error code:',
      { extractionError: 'code getter failed' },
    );
    expect(mockDebugLogger.error).toHaveBeenCalledWith(
      'Workspace memory remember task failed:',
      expect.objectContaining({
        taskId: post.body.taskId,
        code: 'remember_failed',
        details: '<details unavailable>',
      }),
    );
  });

  it('records forget and dream failures with kind-specific error codes', async () => {
    mockDebugLogger.error.mockClear();
    const bridge = buildBridgeStub({
      forgetImpl: vi.fn().mockRejectedValue(new Error('forget failed')),
      dreamImpl: vi.fn().mockRejectedValue(new Error('dream failed')),
    });
    const app = buildApp(bridge);

    const forgetPost = await request(app)
      .post('/workspace/memory/forget')
      .send({ query: 'old preference' })
      .expect(202);
    await waitFor(() => bridge.forgetCalls.length === 1);
    await request(app)
      .get(`/workspace/memory/forget/${forgetPost.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'forget_failed',
          message: 'Workspace memory forget failed.',
          details: 'forget failed',
        });
      });
    expect(mockDebugLogger.error).toHaveBeenCalledWith(
      'Workspace memory forget task failed:',
      expect.objectContaining({
        taskId: forgetPost.body.taskId,
        code: 'forget_failed',
        details: 'forget failed',
        stack: expect.stringContaining('forget failed'),
      }),
    );

    const dreamPost = await request(app)
      .post('/workspace/memory/dream')
      .send({})
      .expect(202);
    await waitFor(() => bridge.dreamCalls === 1);
    await request(app)
      .get(`/workspace/memory/dream/${dreamPost.body.taskId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('failed');
        expect(res.body.error).toEqual({
          code: 'dream_failed',
          message: 'Workspace memory dream failed.',
          details: 'dream failed',
        });
      });
    expect(mockDebugLogger.error).toHaveBeenCalledWith(
      'Workspace memory dream task failed:',
      expect.objectContaining({
        taskId: dreamPost.body.taskId,
        code: 'dream_failed',
        details: 'dream failed',
        stack: expect.stringContaining('dream failed'),
      }),
    );
  });
});
