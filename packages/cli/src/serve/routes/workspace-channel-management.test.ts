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
  ChannelRuntimeState,
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
  const result = (
    name: string,
    state: ChannelRuntimeState['state'],
    config: Record<string, unknown> = {},
  ): ChannelMutationResult => ({
    snapshot: { revision: state === 'stopped' ? 'r2' : 'r1', instances: {} },
    instance: {
      name,
      config,
      secrets: {},
      startsWithServe: false,
      runtime: { state },
    },
  });
  return {
    list: vi.fn(async () => ({ revision: 'r1', instances: {} })),
    upsert: vi.fn(async (name) =>
      result(name, 'stopped', { type: 'telegram' }),
    ),
    remove: vi.fn(async (name) => result(name, 'stopped')),
    start: vi.fn(async (name) => result(name, 'connected')),
    stop: vi.fn(async (name) => result(name, 'stopped')),
    restart: vi.fn(async (name) => result(name, 'connected')),
  };
}

function mount(opts: {
  primaryTrusted?: boolean;
  secondaryTrusted?: boolean;
  services?: Map<string, ChannelManagementService>;
  resolveService?: (
    target: WorkspaceRuntime,
  ) => ChannelManagementService | Promise<ChannelManagementService> | undefined;
}) {
  const primary = runtime('primary', '/work/primary', opts.primaryTrusted);
  const secondary = runtime(
    'secondary',
    '/work/secondary',
    opts.secondaryTrusted,
  );
  const primaryService = service();
  const secondaryService = service();
  const services =
    opts.services ??
    new Map([
      [primary.workspaceCwd, primaryService],
      [secondary.workspaceCwd, secondaryService],
    ]);
  const strictOptions: Array<{ strict?: boolean } | undefined> = [];
  const mutate = (mutationOpts?: { strict?: boolean }): RequestHandler => {
    strictOptions.push(mutationOpts);
    return (req, res, next) => {
      if (req.header('authorization') !== 'Bearer secret') {
        res.status(401).json({ code: 'token_required' });
        return;
      }
      next();
    };
  };
  const parseAndValidateClientId = vi.fn((_req, _res) => 'client-1');
  const app = express();
  app.use(express.json());
  registerWorkspaceChannelManagementRoutes(app, {
    primaryRuntime: primary,
    workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
    resolveService:
      opts.resolveService ?? ((target) => services.get(target.workspaceCwd)),
    mutate,
    safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
    parseAndValidateClientId,
  });
  return {
    app,
    primary,
    secondary,
    primaryService,
    secondaryService,
    strictOptions,
    parseAndValidateClientId,
  };
}

const auth = (value: request.Test) =>
  value
    .set('Authorization', 'Bearer secret')
    .set('X-Qwen-Client-Id', 'client-1');

describe('workspace Channel management routes', () => {
  it('lists the catalog and configured instances for a trusted workspace', async () => {
    const { app, primaryService } = mount({});

    const catalog = await request(app).get('/workspace/channel-types');
    const channels = await request(app).get('/workspace/channels');

    expect(catalog.status).toBe(200);
    expect(catalog.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'telegram', manageable: true }),
      ]),
    );
    expect(channels.status).toBe(200);
    expect(channels.body).toEqual({ revision: 'r1', instances: {} });
    expect(primaryService.list).toHaveBeenCalledOnce();
  });

  it('routes CRUD and lifecycle mutations through strict auth and client validation', async () => {
    const { app, primaryService, strictOptions, parseAndValidateClientId } =
      mount({});

    expect(
      (await request(app).put('/workspace/channels/bot').send({})).status,
    ).toBe(401);
    await auth(
      request(app)
        .put('/workspace/channels/bot')
        .send({
          expectedRevision: 'r1',
          config: { type: 'telegram' },
          secrets: { token: { operation: 'preserve' } },
        }),
    ).expect(200);
    await auth(
      request(app)
        .delete('/workspace/channels/bot')
        .send({ expectedRevision: 'r2' }),
    ).expect(200);
    await auth(request(app).post('/workspace/channels/bot/start')).expect(200);
    await auth(request(app).post('/workspace/channels/bot/stop')).expect(200);
    await auth(request(app).post('/workspace/channels/bot/restart')).expect(
      200,
    );

    expect(primaryService.upsert).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r1',
      config: { type: 'telegram' },
      secrets: { token: { operation: 'preserve' } },
    });
    expect(primaryService.remove).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r2',
    });
    expect(primaryService.start).toHaveBeenCalledWith('bot');
    expect(primaryService.stop).toHaveBeenCalledWith('bot');
    expect(primaryService.restart).toHaveBeenCalledWith('bot');
    expect(strictOptions).toHaveLength(5);
    expect(strictOptions).toEqual(
      Array.from({ length: 5 }, () => ({ strict: true })),
    );
    expect(parseAndValidateClientId).toHaveBeenCalledTimes(5);
  });

  it('returns 409 for stale PUT', async () => {
    const { app, primaryService } = mount({});
    vi.mocked(primaryService.upsert).mockRejectedValue(
      Object.assign(new Error('stale'), {
        code: 'channel_settings_conflict',
      }),
    );

    const response = await auth(
      request(app)
        .put('/workspace/channels/bot')
        .send({
          expectedRevision: 'stale',
          config: { type: 'telegram' },
          secrets: {},
        }),
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('channel_settings_conflict');
    expect(primaryService.upsert).toHaveBeenCalledOnce();
  });

  it('does not route an untrusted secondary workspace to primary', async () => {
    const { app, primaryService, secondaryService } = mount({
      secondaryTrusted: false,
    });

    const response = await request(app).get('/workspaces/secondary/channels');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(primaryService.list).not.toHaveBeenCalled();
    expect(secondaryService.list).not.toHaveBeenCalled();
  });

  it('uses only the selected trusted secondary service', async () => {
    const { app, primaryService, secondaryService } = mount({});

    const response = await auth(
      request(app)
        .delete('/workspaces/secondary/channels/bot')
        .send({ expectedRevision: 'r1' }),
    );

    expect(response.status).toBe(200);
    expect(secondaryService.remove).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r1',
    });
    expect(primaryService.remove).not.toHaveBeenCalled();
  });

  it('rejects invalid instance names and request bodies before the service', async () => {
    const { app, primaryService } = mount({});

    const encodedSlash = await auth(
      request(app).post('/workspace/channels/a%2Fb/start'),
    );
    const overlong = await auth(
      request(app).post(`/workspace/channels/${'a'.repeat(257)}/start`),
    );
    const invalidPut = await auth(
      request(app)
        .put('/workspace/channels/bot')
        .send({
          expectedRevision: '',
          config: { type: '' },
          secrets: [],
        }),
    );

    expect(encodedSlash.status).toBe(400);
    expect(encodedSlash.body.code).toBe('invalid_channel_instance_name');
    expect(overlong.status).toBe(400);
    expect(invalidPut.status).toBe(400);
    expect(invalidPut.body.code).toBe('invalid_channel_management_request');
    expect(primaryService.start).not.toHaveBeenCalled();
    expect(primaryService.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['channel_settings_invalid_secret', 400],
    ['channel_settings_unmanageable', 400],
    ['channel_workspace_mismatch', 400],
    ['ambiguous_channel_workspace', 400],
    ['untrusted_workspace', 403],
    ['channel_instance_not_found', 404],
    ['channel_runtime_owner_mismatch', 409],
    ['channel_worker_not_enabled', 409],
    ['channel_worker_start_failed', 502],
    ['channel_worker_stop_failed', 500],
    ['daemon_draining', 503],
  ])('maps %s to HTTP %i', async (code, status) => {
    const { app, primaryService } = mount({});
    vi.mocked(primaryService.start).mockRejectedValue(
      Object.assign(new Error('known failure'), { code }),
    );

    const response = await auth(
      request(app).post('/workspace/channels/bot/start'),
    );

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: 'known failure', code });
  });

  it('maps service initialization failures without leaking through Express', async () => {
    const { app } = mount({
      resolveService: async () => {
        throw Object.assign(new Error('manager unavailable'), {
          code: 'channel_worker_unavailable',
        });
      },
    });

    const response = await request(app).get('/workspace/channels');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'manager unavailable',
      code: 'channel_worker_unavailable',
    });
  });
});
