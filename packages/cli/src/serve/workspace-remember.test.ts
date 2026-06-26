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
  BridgeWorkspaceMemoryRememberRequest,
  BridgeWorkspaceMemoryRememberResult,
} from './acp-session-bridge.js';
import type { BridgeEvent } from './event-bus.js';
import { mountWorkspaceMemoryRememberRoutes } from './workspace-remember.js';

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
  rememberImpl?: (
    req: BridgeWorkspaceMemoryRememberRequest,
  ) => Promise<BridgeWorkspaceMemoryRememberResult>;
}): AcpSessionBridge & {
  events: RecordedEvent[];
  rememberCalls: BridgeWorkspaceMemoryRememberRequest[];
} {
  const events: RecordedEvent[] = [];
  const rememberCalls: BridgeWorkspaceMemoryRememberRequest[] = [];
  const known = new Set<string>(opts.knownIds ?? []);
  const rememberImpl =
    opts.rememberImpl ??
    (async () => ({
      summary: 'saved',
      filesTouched: ['/mem/project/MEMORY.md'],
      touchedScopes: ['project'],
    }));

  return {
    events,
    rememberCalls,
    publishWorkspaceEvent(event: RecordedEvent) {
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
    async isWorkspaceMemoryRememberAvailable() {
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
    killSession: async () => {},
    detachClient: async () => {},
    sessionCount: 0,
    pendingPermissionCount: 0,
    killAllSync: () => {},
    shutdown: async () => {},
    preheat: async () => {},
  } as unknown as AcpSessionBridge & {
    events: RecordedEvent[];
    rememberCalls: BridgeWorkspaceMemoryRememberRequest[];
  };
}

function buildApp(bridge: AcpSessionBridge) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountWorkspaceMemoryRememberRoutes(app, {
    bridge,
    mutate: createMutationGate({
      tokenConfigured: true,
      requireAuth: false,
    }),
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
    await waitFor(() => bridge.rememberCalls.length === 1);
    await waitFor(() => bridge.events.length === 1);

    const get = await request(app)
      .get(`/workspace/memory/remember/${taskId}`)
      .expect(200);
    expect(get.body).toMatchObject({
      taskId,
      status: 'completed',
      contextMode: 'clean',
      result: {
        summary: 'saved',
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
    await waitFor(() => bridge.events.length === 2);

    await request(app)
      .get(`/workspace/memory/remember/${postOne.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
    await request(app)
      .get(`/workspace/memory/remember/${postTwo.body.taskId}`)
      .expect(200)
      .expect((res) => expect(res.body.status).toBe('completed'));
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
});
