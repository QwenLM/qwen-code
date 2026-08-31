/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StandaloneSessionServiceError,
  type ListStandaloneSessionsOptions,
  type StandaloneSessionService,
} from '../conversations/standalone-session-service.js';
import { sendBridgeError } from '../server/error-response.js';
import { InvalidCursorError } from '../server/session-list.js';
import { registerStandaloneSessionRoutes } from './standalone-sessions.js';

const sessionId = '11111111-1111-4111-8111-111111111111';

function createHarness({
  isWorkspaceTrusted = () => true,
}: {
  isWorkspaceTrusted?: () => boolean;
} = {}) {
  const service = {
    create: vi.fn(async () => ({
      session: {
        sessionId,
        clientId: 'client-1',
        workspaceCwd: '/conversations',
        attached: false,
        sourceType: 'standalone',
      },
      projectlessOutputDirectory: '/conversations/conversation-child',
      workingDirectory: { state: 'ready' as const },
    })),
    list: vi.fn(async (_options: ListStandaloneSessionsOptions = {}) => ({
      sessions: [],
    })),
    get: vi.fn(async () => ({
      sessionId,
      workspaceCwd: '/conversations',
      sourceType: 'standalone',
      context: { kind: 'standalone' as const },
      clientCount: 0,
      hasActivePrompt: false,
      isArchived: false,
    })),
    load: vi.fn(async () => ({ sessionId, action: 'load' })),
    resume: vi.fn(async () => ({ sessionId, action: 'resume' })),
    repairDirectory: vi.fn(async () => ({
      sessionId,
      projectlessOutputDirectory: '/conversations/conversation-child',
      workingDirectory: { state: 'ready' as const },
    })),
    rename: vi.fn(async (_id, displayName: string) => ({
      sessionId,
      displayName,
    })),
    export: vi.fn(async () => ({
      format: 'md' as const,
      filename: 'session.md',
      mimeType: 'text/markdown; charset=utf-8',
      content: '# Session',
    })),
    archive: vi.fn(async () => ({
      archived: [sessionId],
      alreadyArchived: [],
      notFound: [],
      errors: [],
    })),
    unarchive: vi.fn(async () => ({
      unarchived: [sessionId],
      alreadyActive: [],
      notFound: [],
      errors: [],
    })),
    delete: vi.fn(async () => ({
      removed: [sessionId],
      notFound: [],
      errors: [],
      fileCleanupPending: [],
    })),
    cleanupDisconnectedCreate: vi.fn(async () => undefined),
    cleanupDisconnectedRestore: vi.fn(async () => undefined),
  };
  const mutate = vi.fn(() => ((_req, _res, next) => next()) as RequestHandler);
  const app = express();
  app.use(express.json());
  registerStandaloneSessionRoutes(app, {
    service: service as unknown as StandaloneSessionService,
    mutate,
    sendBridgeError,
    isWorkspaceTrusted,
  });
  return { app, service, mutate };
}

describe('standalone session routes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a prompt-less standalone session without workspace inputs', async () => {
    const { app, service } = createHarness();

    const response = await request(app)
      .post('/standalone/sessions')
      .send({ sessionId, approvalMode: 'default' });

    expect(response.status).toBe(200);
    expect(service.create).toHaveBeenCalledWith({
      sessionId,
      approvalMode: 'default',
    });
    expect(response.body).toMatchObject({
      sessionId,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
      workingDirectory: { state: 'ready' },
    });
  });

  it('detaches only the response client when creation outlives the request', async () => {
    const { app, service } = createHarness();
    service.cleanupDisconnectedCreate.mockRejectedValueOnce(
      new Error('transient'),
    );
    let finishCreate!: () => void;
    service.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCreate = () =>
            resolve({
              session: {
                sessionId,
                clientId: 'client-1',
                workspaceCwd: '/conversations',
                attached: false,
                sourceType: 'standalone',
              },
              projectlessOutputDirectory: '/conversations/conversation-child',
              workingDirectory: { state: 'ready' },
            });
        }),
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ sessionId });
    const operation = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/standalone/sessions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    operation.on('error', () => undefined);
    operation.end(body);
    await vi.waitFor(() => expect(service.create).toHaveBeenCalledOnce());

    operation.destroy();
    await vi.waitFor(async () => {
      const connections = await new Promise<number>((resolve, reject) =>
        server.getConnections((error, count) =>
          error ? reject(error) : resolve(count),
        ),
      );
      expect(connections).toBe(0);
    });
    finishCreate();

    await vi.waitFor(() =>
      expect(service.cleanupDisconnectedCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            sessionId,
            clientId: 'client-1',
          }),
        }),
      ),
    );
    expect(service.cleanupDisconnectedCreate).toHaveBeenCalledTimes(2);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each([
    [{ sessionId, cwd: '/tmp' }, 'unknown fields'],
    [[], 'JSON object'],
    [{ sessionId, approvalMode: 'unknown' }, 'known approval mode'],
  ])(
    'rejects invalid create bodies before calling the service',
    async (body, message) => {
      const { app, service } = createHarness();

      const response = await request(app)
        .post('/standalone/sessions')
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(message);
      expect(service.create).not.toHaveBeenCalled();
    },
  );

  it('returns 202 while an exact session id is still creating', async () => {
    const { app, service } = createHarness();
    service.get.mockResolvedValueOnce({
      sessionId,
      state: 'creating',
    } as never);

    const response = await request(app).get(
      `/standalone/sessions/${sessionId}`,
    );

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ sessionId, state: 'creating' });
  });

  it('validates and forwards list query options', async () => {
    const { app, service } = createHarness();

    const response = await request(app).get(
      '/standalone/sessions?cursor=next&size=25&archiveState=archived',
    );

    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'next',
        size: 25,
        archiveState: 'archived',
        signal: expect.any(AbortSignal),
      }),
    );

    const invalid = await request(app).get('/standalone/sessions?cwd=/tmp');
    expect(invalid.status).toBe(400);
    expect(service.list).toHaveBeenCalledOnce();
  });

  it('returns invalid_cursor for an invalid standalone list cursor', async () => {
    const { app, service } = createHarness();
    service.list.mockRejectedValueOnce(new InvalidCursorError('invalid'));

    const response = await request(app).get(
      '/standalone/sessions?cursor=invalid',
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'Invalid cursor: "invalid" is not a valid numeric cursor',
      code: 'invalid_cursor',
    });
  });

  it('aborts a standalone catalog scan when the request disconnects', async () => {
    const { app, service } = createHarness();
    let listSignal: AbortSignal | undefined;
    service.list.mockImplementationOnce(
      async (options: ListStandaloneSessionsOptions = {}) => {
        listSignal = options.signal;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        return { sessions: [] };
      },
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const operation = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/standalone/sessions',
      method: 'GET',
    });
    operation.on('error', () => undefined);
    operation.end();
    await vi.waitFor(() => expect(service.list).toHaveBeenCalledOnce());

    operation.destroy();

    await vi.waitFor(() => expect(listSignal?.aborted).toBe(true));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(['load', 'resume'] as const)(
    'accepts only restore options on %s',
    async (action) => {
      const { app, service } = createHarness();

      const response = await request(app)
        .post(`/standalone/sessions/${sessionId}/${action}`)
        .set('X-Qwen-Client-Id', 'client-1')
        .send({
          historyPageSize: 20,
          liveReplayMode: 'summary',
          hideInheritedHistory: true,
        });

      expect(response.status).toBe(200);
      expect(service[action]).toHaveBeenCalledWith(sessionId, {
        clientId: 'client-1',
        historyPageSize: 20,
        liveReplayMode: 'summary',
        hideInheritedHistory: true,
      });

      const forbidden = await request(app)
        .post(`/standalone/sessions/${sessionId}/${action}`)
        .send({ workspaceCwd: '/tmp' });
      expect(forbidden.status).toBe(400);
      expect(service[action]).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['load', false],
    ['resume', true],
  ] as const)(
    'cleans up a %s restore that finishes after the request disconnects',
    async (action, attached) => {
      const { app, service } = createHarness();
      service.cleanupDisconnectedRestore.mockRejectedValueOnce(
        new Error('transient'),
      );
      let finishRestore!: () => void;
      const restored = {
        sessionId,
        clientId: 'response-client',
        workspaceCwd: '/conversations',
        currentCwd: '/conversations/conversation-child',
        attached,
        sourceType: 'standalone' as const,
        context: { kind: 'standalone' as const },
        projectlessOutputDirectory: '/conversations/conversation-child',
        workingDirectory: { state: 'ready' as const },
        state: {},
      };
      service[action].mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRestore = () => resolve(restored as never);
          }),
      );
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const operation = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: `/standalone/sessions/${sessionId}/${action}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      operation.on('error', () => undefined);
      operation.end('{}');
      await vi.waitFor(() => expect(service[action]).toHaveBeenCalledOnce());

      operation.destroy();
      await vi.waitFor(async () => {
        const connections = await new Promise<number>((resolve, reject) =>
          server.getConnections((error, count) =>
            error ? reject(error) : resolve(count),
          ),
        );
        expect(connections).toBe(0);
      });
      finishRestore();

      await vi.waitFor(() =>
        expect(service.cleanupDisconnectedRestore).toHaveBeenCalledWith(
          restored,
        ),
      );
      expect(service.cleanupDisconnectedRestore).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  );

  it('redacts full skill details from standalone restore replay arrays', async () => {
    const { app, service } = createHarness();
    service.load.mockResolvedValueOnce({
      sessionId,
      compactedReplay: [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [],
              _meta: {
                availableSkills: ['bugfix'],
                availableSkillDetails: [
                  { name: 'bugfix', body: 'full skill body' },
                ],
              },
            },
          },
        },
      ],
    } as never);

    const response = await request(app)
      .post(`/standalone/sessions/${sessionId}/load`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.compactedReplay[0].data.update._meta).toEqual({
      availableSkills: ['bugfix'],
    });
    expect(JSON.stringify(response.body)).not.toContain('full skill body');
  });

  it.each(['load', 'resume'] as const)(
    'redacts workflows from untrusted standalone %s replay arrays',
    async (action) => {
      const { app, service } = createHarness({
        isWorkspaceTrusted: () => false,
      });
      const commandsEvent = {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'help', description: 'Help' },
              { name: 'workflows', description: 'Manage workflows' },
            ],
          },
        },
      };
      service[action].mockResolvedValueOnce({
        sessionId,
        compactedReplay: [commandsEvent],
        liveJournal: [commandsEvent],
      } as never);

      const response = await request(app)
        .post(`/standalone/sessions/${sessionId}/${action}`)
        .send({});

      expect(response.status).toBe(200);
      for (const replayKey of ['compactedReplay', 'liveJournal'] as const) {
        expect(
          response.body[replayKey][0].data.update.availableCommands.map(
            (command: { name: string }) => command.name,
          ),
        ).toEqual(['help']);
      }
    },
  );

  it('repairs an exact directory only with an empty object body', async () => {
    const { app, service } = createHarness();

    const response = await request(app).post(
      `/standalone/sessions/${sessionId}/repair-directory`,
    );

    expect(response.status).toBe(200);
    expect(service.repairDirectory).toHaveBeenCalledWith(sessionId);

    const invalid = await request(app)
      .post(`/standalone/sessions/${sessionId}/repair-directory`)
      .send({ prompt: 'do not replay' });
    expect(invalid.status).toBe(400);
    expect(service.repairDirectory).toHaveBeenCalledOnce();
  });

  it('rejects prototype keys instead of dropping them during body cleanup', async () => {
    const { app, service } = createHarness();

    const response = await request(app)
      .post('/standalone/sessions')
      .set('Content-Type', 'application/json')
      .send(`{"sessionId":"${sessionId}","__proto__":{"cwd":"/tmp"}}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('unknown fields');
    expect(service.create).not.toHaveBeenCalled();
  });

  it('renames with the request client identity', async () => {
    const { app, service } = createHarness();

    const response = await request(app)
      .patch(`/standalone/sessions/${sessionId}/metadata`)
      .set('X-Qwen-Client-Id', 'client-1')
      .send({ displayName: 'Named session' });

    expect(response.status).toBe(200);
    expect(service.rename).toHaveBeenCalledWith(
      sessionId,
      'Named session',
      'client-1',
    );
  });

  it('streams an export with the existing renderer metadata', async () => {
    const { app, service } = createHarness();

    const response = await request(app).get(
      `/standalone/sessions/${sessionId}/export?format=md`,
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="session.md"',
    );
    expect(response.text).toBe('# Session');
    expect(service.export).toHaveBeenCalledWith(sessionId, 'md');
  });

  it.each(['archive', 'unarchive', 'delete'] as const)(
    'forwards validated %s batches',
    async (action) => {
      const { app, service } = createHarness();

      const response = await request(app)
        .post(`/standalone/sessions/${action}`)
        .send({ sessionIds: [sessionId, sessionId] });

      expect(response.status).toBe(200);
      expect(service[action]).toHaveBeenCalledWith([sessionId, sessionId]);

      const invalid = await request(app)
        .post(`/standalone/sessions/${action}`)
        .send({ sessionIds: [] });
      expect(invalid.status).toBe(400);
      expect(service[action]).toHaveBeenCalledOnce();
    },
  );

  it('uses the centralized standalone error serializer', async () => {
    const { app, service } = createHarness();
    service.get.mockRejectedValueOnce(
      new StandaloneSessionServiceError(
        'deletion_recovery_compromised',
        sessionId,
        'Deletion recovery is compromised.',
      ),
    );

    const response = await request(app).get(
      `/standalone/sessions/${sessionId}`,
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Deletion recovery is compromised.',
      code: 'deletion_recovery_compromised',
      errorKind: 'deletion_recovery_compromised',
      retryable: false,
      sessionId,
    });
  });
});
