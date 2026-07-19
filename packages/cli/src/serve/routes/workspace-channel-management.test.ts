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
import type { ChannelAuthSessionManager } from '../channel-auth-session-manager.js';
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
      webhookSecrets: {},
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
    setStartup: vi.fn(async (name, request) => ({
      ...result(name, 'stopped'),
      instance: {
        ...result(name, 'stopped').instance,
        startsWithServe: request.enabled,
      },
    })),
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
  authManager?: ChannelAuthSessionManager;
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
  const parseAndValidateClientId = vi.fn((req, _res) =>
    req.header('x-qwen-client-id'),
  );
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
    authManager: opts.authManager,
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

function authManager(): ChannelAuthSessionManager {
  return {
    begin: vi.fn(async () => ({
      id: 'session-1',
      state: 'awaiting_scan' as const,
      expiresAt: '2026-07-19T01:00:00.000Z',
      qrRevision: 1,
    })),
    get: vi.fn(() => ({
      id: 'session-1',
      state: 'awaiting_scan' as const,
      expiresAt: '2026-07-19T01:00:00.000Z',
      qrRevision: 1,
    })),
    getQr: vi.fn((sessionKey) => {
      if (sessionKey.clientId !== 'client-1') {
        throw Object.assign(new Error('not found'), {
          code: 'channel_auth_session_not_found',
        });
      }
      return { payload: 'https://example.test/secret', revision: 1 };
    }),
    cancel: vi.fn(() => ({
      id: 'session-1',
      state: 'cancelled' as const,
      expiresAt: '2026-07-19T01:00:00.000Z',
      qrRevision: 1,
    })),
    commit: vi.fn(async () => ({
      id: 'session-1',
      state: 'committed' as const,
      expiresAt: '2026-07-19T01:00:00.000Z',
      qrRevision: 1,
    })),
    removeWorkspace: vi.fn(),
    shutdown: vi.fn(),
  };
}

function authService(): ChannelManagementService {
  const value = service();
  vi.mocked(value.list).mockResolvedValue({
    revision: 'r1',
    instances: {
      bot: {
        name: 'bot',
        config: { type: 'weixin' },
        secrets: {},
        webhookSecrets: {},
        startsWithServe: false,
        runtime: { state: 'stopped' },
      },
    },
  });
  return value;
}

const auth = (value: request.Test) =>
  value
    .set('Authorization', 'Bearer secret')
    .set('X-Qwen-Client-Id', 'client-1');

describe('workspace Channel management routes', () => {
  it('serves a non-cacheable QR only to the creating client', async () => {
    const manager = authManager();
    const configured = authService();
    const { app } = mount({
      authManager: manager,
      services: new Map([
        ['/work/primary', configured],
        ['/work/secondary', authService()],
      ]),
    });

    const begin = await auth(
      request(app)
        .post('/workspace/channels/bot/auth-sessions')
        .send({ channelType: 'weixin' }),
    );
    const qrPath = `/workspace/channels/bot/auth-sessions/${begin.body.id}/qr`;
    const wrong = await request(app)
      .get(qrPath)
      .set('Authorization', 'Bearer secret')
      .set('X-Qwen-Client-Id', 'client-b');
    const right = await auth(request(app).get(qrPath));

    expect(begin.status).toBe(201);
    expect(wrong.status).toBe(404);
    expect(right.status).toBe(200);
    expect(right.headers['cache-control']).toBe('no-store');
    expect(right.headers['x-content-type-options']).toBe('nosniff');
    expect(right.headers['content-type']).toMatch(/^image\/svg\+xml/u);
    expect(right.body.toString('utf8')).not.toContain(
      'https://example.test/secret',
    );
  });

  it('uses strict auth for begin, cancel, and commit and normal auth for status and QR', async () => {
    const manager = authManager();
    const configured = authService();
    const { app, strictOptions } = mount({
      authManager: manager,
      services: new Map([
        ['/work/primary', configured],
        ['/work/secondary', authService()],
      ]),
    });
    const root = '/workspace/channels/bot/auth-sessions';

    await auth(request(app).post(root).send({ channelType: 'weixin' })).expect(
      201,
    );
    await auth(request(app).get(`${root}/session-1`)).expect(200);
    await auth(request(app).delete(`${root}/session-1`)).expect(200);
    await auth(
      request(app)
        .post(`${root}/session-1/commit`)
        .send({ channelType: 'weixin' }),
    )
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          snapshot: { revision: 'r1' },
          instance: { name: 'bot', config: { type: 'weixin' } },
        });
      });

    expect(strictOptions.slice(-5)).toEqual([
      { strict: true },
      undefined,
      { strict: true },
      undefined,
      { strict: true },
    ]);
  });

  it('fails closed for qualified auth and hides key ownership mismatches as 404', async () => {
    const manager = authManager();
    vi.mocked(manager.get).mockImplementation(() => {
      throw Object.assign(new Error('private mismatch'), {
        code: 'channel_auth_session_not_found',
      });
    });
    const { app } = mount({
      authManager: manager,
      secondaryTrusted: false,
      services: new Map([
        ['/work/primary', authService()],
        ['/work/secondary', authService()],
      ]),
    });

    const untrusted = await auth(
      request(app)
        .post('/workspaces/secondary/channels/bot/auth-sessions')
        .send({ channelType: 'weixin' }),
    );
    const mismatch = await auth(
      request(app).get(
        '/workspace/channels/bot/auth-sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    );

    expect(untrusted.status).toBe(403);
    expect(mismatch.status).toBe(404);
    expect(mismatch.body).toEqual({
      error: 'Channel authentication session was not found.',
      code: 'channel_auth_session_not_found',
    });
  });

  it('bounds auth inputs and requires bearer auth plus a client id', async () => {
    const manager = authManager();
    const { app } = mount({
      authManager: manager,
      services: new Map([
        ['/work/primary', authService()],
        ['/work/secondary', authService()],
      ]),
    });
    const root = '/workspace/channels/bot/auth-sessions';

    await request(app).get(`${root}/session-1`).expect(401);
    const missingClient = await request(app)
      .get(`${root}/session-1`)
      .set('Authorization', 'Bearer secret');
    const invalidType = await auth(
      request(app).post(root).send({ channelType: 'weixin/unsafe' }),
    );
    const invalidSession = await auth(
      request(app).get(`${root}/${'a'.repeat(129)}`),
    );

    expect(missingClient.body.code).toBe('channel_auth_client_required');
    expect(invalidType.body.code).toBe('invalid_channel_auth_request');
    expect(invalidSession.body.code).toBe('invalid_channel_auth_session_id');
    expect(manager.begin).not.toHaveBeenCalled();
    expect(manager.get).not.toHaveBeenCalled();
  });

  it('returns stable sanitized auth errors without credential text', async () => {
    const manager = authManager();
    vi.mocked(manager.begin).mockRejectedValue(
      Object.assign(new Error('Authorization: Bearer private-token\nfailed'), {
        code: 'channel_auth_failed',
      }),
    );
    const { app } = mount({
      authManager: manager,
      services: new Map([
        ['/work/primary', authService()],
        ['/work/secondary', authService()],
      ]),
    });

    const response = await auth(
      request(app)
        .post('/workspace/channels/bot/auth-sessions')
        .send({ channelType: 'weixin' }),
    );

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('channel_auth_failed');
    expect(response.body.error).not.toContain('private-token');
    expect(response.body.error.length).toBeLessThanOrEqual(512);
  });
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
          webhookSecrets: { github: { operation: 'preserve' } },
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
      config: { type: 'telegram' },
      secrets: { token: { operation: 'preserve' } },
      webhookSecrets: { github: { operation: 'preserve' } },
    });
    expect(primaryService.remove).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r2',
    });
    expect(primaryService.setStartup).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r2',
      enabled: true,
    });
    expect(primaryService.start).toHaveBeenCalledWith('bot');
    expect(primaryService.stop).toHaveBeenCalledWith('bot');
    expect(primaryService.restart).toHaveBeenCalledWith('bot');
    expect(strictOptions).toHaveLength(6);
    expect(strictOptions).toEqual(
      Array.from({ length: 6 }, () => ({ strict: true })),
    );
    expect(parseAndValidateClientId).toHaveBeenCalledTimes(6);
  });

  it('routes qualified startup changes only to the trusted selected workspace', async () => {
    const { app, primaryService, secondaryService } = mount({});

    await auth(
      request(app)
        .put('/workspaces/secondary/channels/bot/startup')
        .send({ expectedRevision: 'r1', enabled: false }),
    ).expect(200);

    expect(secondaryService.setStartup).toHaveBeenCalledWith('bot', {
      expectedRevision: 'r1',
      enabled: false,
    });
    expect(primaryService.setStartup).not.toHaveBeenCalled();
  });

  it('rejects invalid startup bodies before calling the service', async () => {
    const { app, primaryService } = mount({});

    const response = await auth(
      request(app)
        .put('/workspace/channels/bot/startup')
        .send({ expectedRevision: 'r1', enabled: 'yes' }),
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_channel_management_request');
    expect(primaryService.setStartup).not.toHaveBeenCalled();
  });

  it.each(['secrets', 'webhookSecrets'] as const)(
    'rejects malformed %s entries at the route boundary',
    async (mapName) => {
      const invalidMaps: unknown[] = [
        null,
        [],
        { token: { operation: 'rotate', value: 'new-secret' } },
        { token: null },
        { token: { operation: 'replace', value: '' } },
        { token: [] },
        { token: { operation: 'preserve', value: 'unexpected' } },
        ...['__proto__', 'constructor', 'prototype'].map((key) =>
          Object.fromEntries([[key, { operation: 'preserve' }]]),
        ),
      ];

      for (const invalidMap of invalidMaps) {
        const { app, primaryService } = mount({});
        const response = await auth(
          request(app)
            .put('/workspace/channels/bot')
            .send({
              expectedRevision: 'r1',
              config: { type: 'telegram' },
              [mapName]: invalidMap,
            }),
        );

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('channel_settings_invalid_secret');
        expect(primaryService.upsert).not.toHaveBeenCalled();
      }
    },
  );

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
      request(app).post(`/workspace/channels/${'a'.repeat(256)}/start`),
    );
    const portableUnsafe = await Promise.all(
      ['bad:name', 'bot.', 'NUL.json', '界'.repeat(86)].map((name) =>
        auth(
          request(app).post(
            `/workspace/channels/${encodeURIComponent(name)}/start`,
          ),
        ),
      ),
    );
    const malformedUnicode = await Promise.all(
      ['%ED%A0%80', '%ED%B0%80'].map((encodedName) =>
        auth(request(app).post(`/workspace/channels/${encodedName}/start`)),
      ),
    );
    const reservedPut = await auth(
      request(app)
        .put('/workspace/channels/all')
        .send({ expectedRevision: 'r1', config: { type: 'telegram' } }),
    );
    const reservedStart = await auth(
      request(app).post('/workspace/channels/all/start'),
    );
    const reservedStartup = await auth(
      request(app)
        .put('/workspace/channels/all/startup')
        .send({ expectedRevision: 'r1', enabled: false }),
    );
    const whitespaceReservedPut = await auth(
      request(app)
        .put('/workspace/channels/%20all%20')
        .send({ expectedRevision: 'r1', config: { type: 'telegram' } }),
    );
    const whitespaceReservedStart = await auth(
      request(app).post('/workspace/channels/%09all%0A/start'),
    );
    const whitespaceReservedStartup = await auth(
      request(app)
        .put('/workspace/channels/%20all%20/startup')
        .send({ expectedRevision: 'r1', enabled: false }),
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
    expect(portableUnsafe.map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ]);
    expect(malformedUnicode.map((response) => response.status)).toEqual([
      400, 400,
    ]);
    expect(reservedPut.status).toBe(400);
    expect(reservedStart.status).toBe(400);
    expect(reservedStartup.status).toBe(400);
    expect(whitespaceReservedPut.status).toBe(400);
    expect(whitespaceReservedStart.status).toBe(400);
    expect(whitespaceReservedStartup.status).toBe(400);
    expect(invalidPut.status).toBe(400);
    expect(invalidPut.body.code).toBe('invalid_channel_management_request');
    expect(primaryService.start).not.toHaveBeenCalled();
    expect(primaryService.upsert).not.toHaveBeenCalled();
  });

  it('allows deleting a legacy all config through the management route', async () => {
    const { app, primaryService } = mount({});

    await auth(
      request(app)
        .delete('/workspace/channels/all')
        .send({ expectedRevision: 'r1' }),
    ).expect(200);

    expect(primaryService.remove).toHaveBeenCalledWith('all', {
      expectedRevision: 'r1',
    });

    await auth(
      request(app)
        .delete('/workspace/channels/%20all%20')
        .send({ expectedRevision: 'r2' }),
    ).expect(200);

    expect(primaryService.remove).toHaveBeenCalledWith(' all ', {
      expectedRevision: 'r2',
    });
  });

  it.each([
    ['invalid_channel_instance_name', 400],
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
