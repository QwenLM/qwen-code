/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelManagementService,
  ChannelMutationResult,
} from '../channel-management-service.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceChannelManagementRoutes } from './workspace-channel-management.js';

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted = true,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    bridge: {},
  } as WorkspaceRuntime;
}

function service(): ChannelManagementService {
  const result = (name: string): ChannelMutationResult => ({
    snapshot: { revision: 'r2', instances: {} },
    instance: {
      name,
      config: {},
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    },
  });
  return {
    list: vi.fn(async () => ({ revision: 'r1', instances: {} })),
    upsert: vi.fn(async (name) => result(name)),
    remove: vi.fn(async (name) => result(name)),
    setStartup: vi.fn(async (name) => result(name)),
    start: vi.fn(async (name) => result(name)),
    stop: vi.fn(async (name) => result(name)),
    restart: vi.fn(async (name) => result(name)),
    pairingRequests: vi.fn(async () => ({ requests: [] })),
    approvePairing: vi.fn(async (_name, code) => ({
      approved: {
        senderId: 'sender-1',
        senderName: 'Alice',
        code,
        createdAt: 1,
      },
      requests: [],
    })),
  };
}

function mount(secondaryTrusted = true) {
  const primary = runtime('primary', '/work/primary');
  const secondary = runtime('secondary', '/work/secondary', secondaryTrusted);
  const primaryService = service();
  const secondaryService = service();
  const services = new Map([
    [primary.workspaceCwd, primaryService],
    [secondary.workspaceCwd, secondaryService],
  ]);
  const mutate =
    (_opts?: { strict?: boolean }): RequestHandler =>
    (req, res, next) => {
      if (req.header('authorization') !== 'Bearer secret') {
        res.status(401).json({ code: 'token_required' });
        return;
      }
      next();
    };
  const app = express();
  app.use(express.json());
  registerWorkspaceChannelManagementRoutes(app, {
    primaryRuntime: primary,
    workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
    resolveService: (target) => services.get(target.workspaceCwd),
    mutate,
    safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
    parseAndValidateClientId: (req, res) => {
      const id = req.header('x-qwen-client-id') ?? undefined;
      if (id === 'invalid') {
        res.status(400).json({ code: 'invalid_client_id' });
        return null;
      }
      return id;
    },
  });
  return { app, primaryService, secondaryService };
}

const auth = (test: request.Test) =>
  test
    .set('Authorization', 'Bearer secret')
    .set('X-Qwen-Client-Id', 'client-1');

describe('workspace Channel management routes', () => {
  it('lists catalog and sanitized instances without mutation auth', async () => {
    const { app, primaryService } = mount();

    const catalog = await request(app).get('/workspace/channel-types');
    const channels = await request(app).get('/workspace/channels');

    expect(catalog.status).toBe(200);
    expect(catalog.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dingtalk', manageable: true }),
        expect.objectContaining({ type: 'wecom', manageable: true }),
        expect.objectContaining({ type: 'feishu', manageable: true }),
      ]),
    );
    expect(channels.body).toEqual({ revision: 'r1', instances: {} });
    expect(channels.headers['cache-control']).toBe('no-store');
    expect(primaryService.list).toHaveBeenCalledOnce();
  });

  it('routes strict CRUD and lifecycle mutations to the primary service', async () => {
    const { app, primaryService } = mount();

    await request(app).post('/workspace/channels/bot/start').expect(401);
    await auth(
      request(app)
        .put('/workspace/channels/bot')
        .send({
          expectedRevision: 'r1',
          config: { type: 'dingtalk' },
          secrets: { clientSecret: { operation: 'preserve' } },
        }),
    ).expect(200);
    await auth(
      request(app)
        .delete('/workspace/channels/bot')
        .send({ expectedRevision: 'r2' }),
    ).expect(200);
    await auth(
      request(app)
        .put('/workspace/channels/bot/startup')
        .send({ expectedRevision: 'r2', enabled: true }),
    ).expect(200);
    await auth(request(app).post('/workspace/channels/bot/start')).expect(200);
    await auth(request(app).post('/workspace/channels/bot/stop')).expect(200);
    await auth(request(app).post('/workspace/channels/bot/restart')).expect(
      200,
    );

    expect(primaryService.upsert).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r1',
      config: { type: 'dingtalk' },
      secrets: { clientSecret: { operation: 'preserve' } },
    });
    expect(primaryService.remove).toHaveBeenCalledOnce();
    expect(primaryService.setStartup).toHaveBeenCalledOnce();
    expect(primaryService.start).toHaveBeenCalledOnce();
    expect(primaryService.stop).toHaveBeenCalledOnce();
    expect(primaryService.restart).toHaveBeenCalledOnce();
  });

  it('uses only the exact trusted secondary service', async () => {
    const { app, primaryService, secondaryService } = mount();

    await auth(
      request(app)
        .put('/workspaces/secondary/channels/bot/startup')
        .send({ expectedRevision: 'r1', enabled: false }),
    ).expect(200);

    expect(secondaryService.setStartup).toHaveBeenCalledOnce();
    expect(primaryService.setStartup).not.toHaveBeenCalled();
  });

  it('fails closed for an untrusted secondary workspace', async () => {
    const { app, primaryService, secondaryService } = mount(false);

    const response = await request(app).get('/workspaces/secondary/channels');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(primaryService.list).not.toHaveBeenCalled();
    expect(secondaryService.list).not.toHaveBeenCalled();
  });

  it('lists and approves pairing requests in the selected workspace', async () => {
    const { app, primaryService, secondaryService } = mount();

    await request(app)
      .get('/workspaces/secondary/channels/bot/pairing-requests')
      .expect(401);
    const pairingRequests = await auth(
      request(app).get('/workspaces/secondary/channels/bot/pairing-requests'),
    );
    const approval = await auth(
      request(app)
        .post('/workspaces/secondary/channels/bot/pairing-requests/approve')
        .send({ code: 'abcdefgh' }),
    );

    expect(pairingRequests.status).toBe(200);
    expect(pairingRequests.headers['cache-control']).toBe('no-store');
    expect(approval.status).toBe(200);
    expect(approval.headers['cache-control']).toBe('no-store');
    expect(secondaryService.pairingRequests).toHaveBeenCalledWith('bot');
    expect(secondaryService.approvePairing).toHaveBeenCalledWith(
      'bot',
      'ABCDEFGH',
    );
    expect(primaryService.pairingRequests).not.toHaveBeenCalled();
  });

  it('rejects mutation requests with an invalid client ID', async () => {
    const { app, primaryService } = mount();
    const invalidClient = (test: request.Test) =>
      test
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'invalid');

    const upsert = await invalidClient(
      request(app)
        .put('/workspace/channels/bot')
        .send({ expectedRevision: 'r1', config: { type: 'dingtalk' } }),
    );
    const remove = await invalidClient(
      request(app)
        .delete('/workspace/channels/bot')
        .send({ expectedRevision: 'r1' }),
    );
    const start = await invalidClient(
      request(app).post('/workspace/channels/bot/start'),
    );
    const stop = await invalidClient(
      request(app).post('/workspace/channels/bot/stop'),
    );

    expect(upsert.status).toBe(400);
    expect(upsert.body.code).toBe('invalid_client_id');
    expect(remove.status).toBe(400);
    expect(start.status).toBe(400);
    expect(stop.status).toBe(400);
    expect(primaryService.upsert).not.toHaveBeenCalled();
    expect(primaryService.remove).not.toHaveBeenCalled();
    expect(primaryService.start).not.toHaveBeenCalled();
    expect(primaryService.stop).not.toHaveBeenCalled();
  });

  it('rejects malformed names, revisions, secrets, and pairing codes', async () => {
    const { app, primaryService } = mount();
    vi.mocked(primaryService.upsert).mockRejectedValueOnce(
      Object.assign(new Error('Channel name is not allowed.'), {
        code: 'channel_settings_invalid_name',
      }),
    );
    const invalidName = await auth(
      request(app).post('/workspace/channels/a%2Fb/start'),
    );
    const unsafeName = await auth(
      request(app)
        .put('/workspace/channels/prototype')
        .send({
          expectedRevision: 'r1',
          config: { type: 'dingtalk' },
        }),
    );
    const invalidRevision = await auth(
      request(app)
        .delete('/workspace/channels/bot')
        .send({ expectedRevision: '' }),
    );
    const invalidSecret = await auth(
      request(app)
        .put('/workspace/channels/bot')
        .send({
          expectedRevision: 'r1',
          config: { type: 'dingtalk' },
          secrets: { clientSecret: { operation: 'replace', value: '' } },
        }),
    );
    const invalidPairing = await auth(
      request(app)
        .post('/workspace/channels/bot/pairing-requests/approve')
        .send({ code: 'short' }),
    );

    expect(invalidName.body.code).toBe('invalid_channel_instance_name');
    expect(unsafeName.status).toBe(400);
    expect(unsafeName.body.code).toBe('channel_settings_invalid_name');
    expect(invalidRevision.body.code).toBe(
      'invalid_channel_management_request',
    );
    expect(invalidSecret.body.code).toBe('channel_settings_invalid_secret');
    expect(invalidPairing.body.code).toBe('invalid_channel_pairing_code');
    expect(primaryService.upsert).toHaveBeenCalledOnce();
    expect(primaryService.approvePairing).not.toHaveBeenCalled();
  });
});
