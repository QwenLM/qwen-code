/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChannelEvent,
  channelEventFilePath,
  channelEventScopeDir,
} from '@qwen-code/channel-base';
import type {
  ChannelManagementService,
  ChannelMutationResult,
} from '../channel-management-service.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { ChannelControlWorkspaceLimitError } from '../channel-control-capacity.js';
import { channelLinkMetaForEvents } from '../channel-link-meta.js';
import { registerWorkspaceChannelManagementRoutes } from './workspace-channel-management.js';

// Wrap the real helper so one test can force a settings-loading failure and
// witness the journal route's degrade-to-plain-text path; every other test
// keeps the real implementation.
vi.mock('../channel-link-meta.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../channel-link-meta.js')>();
  return {
    ...actual,
    channelLinkMetaForEvents: vi.fn(actual.channelLinkMetaForEvents),
  };
});

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted = true,
  provenance?: WorkspaceRuntime['provenance'],
  env?: WorkspaceRuntime['env'],
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    provenance,
    env: env ?? { mode: 'parent-process', overlayKeys: [] },
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
        subject: {
          type: 'user' as const,
          id: 'sender-1',
          name: 'Alice',
        },
        code,
        createdAt: 1,
      },
      requests: [],
    })),
    pairingApprovals: vi.fn(async () => ({
      senderIds: ['sender-1'],
      groupIds: ['group-1'],
    })),
    revokePairingApproval: vi.fn(async (_name, subject) => ({
      revoked: subject.id,
      senderIds: [],
      groupIds: [],
    })),
  };
}

function mount(
  secondaryTrusted = true,
  primaryOverrides?: { cwd?: string; env?: WorkspaceRuntime['env'] },
) {
  const primary = runtime(
    'primary',
    primaryOverrides?.cwd ?? '/work/primary',
    true,
    undefined,
    primaryOverrides?.env,
  );
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
  it.each([
    '/workspace/channels/bot/start',
    '/workspaces/secondary/channels/bot/start',
  ])('returns 409 for capacity on %s', async (url) => {
    const test = mount();
    vi.mocked(test.primaryService.start).mockRejectedValue(
      new ChannelControlWorkspaceLimitError(),
    );
    vi.mocked(test.secondaryService.start).mockRejectedValue(
      new ChannelControlWorkspaceLimitError(),
    );
    const response = await request(test.app)
      .post(url)
      .set('authorization', 'Bearer secret')
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('channel_control_workspace_limit_reached');
  });

  it('lists catalog and sanitized instances without mutation auth', async () => {
    const { app, primaryService, secondaryService } = mount();

    const catalog = await request(app).get('/workspace/channel-types');
    const channels = await request(app).get('/workspace/channels');

    expect(catalog.status).toBe(200);
    expect(catalog.headers['cache-control']).toBe('no-store');
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

    const qualifiedCatalog = await request(app).get(
      '/workspaces/secondary/channel-types',
    );
    expect(qualifiedCatalog.status).toBe(200);
    expect(qualifiedCatalog.headers['cache-control']).toBe('no-store');
    expect(qualifiedCatalog.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dingtalk', manageable: true }),
      ]),
    );
    expect(secondaryService.list).not.toHaveBeenCalled();
  });

  it('serves the channel-type catalog without the management service', async () => {
    const primary = runtime('primary', '/work/primary');
    const app = express();
    app.use(express.json());
    registerWorkspaceChannelManagementRoutes(app, {
      primaryRuntime: primary,
      workspaceRegistry: createWorkspaceRegistry([primary]),
      resolveService: () => undefined,
      mutate: () => (req, res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      parseAndValidateClientId: () => undefined,
    });

    const response = await request(app).get('/workspace/channel-types');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dingtalk', manageable: true }),
      ]),
    );
  });

  it('advertises the exact nested object descriptor shape on the wire', async () => {
    const { app } = mount();

    const response = await request(app).get('/workspace/channel-types');

    expect(response.status).toBe(200);
    const dingtalk = (
      response.body as Array<{ type: string; fields: unknown[] }>
    ).find((entry) => entry.type === 'dingtalk');
    expect(dingtalk?.fields).toContainEqual({
      key: 'interactiveCards',
      label: 'Interactive Cards',
      kind: 'object',
      properties: [
        { key: 'enabled', label: 'Enabled', kind: 'boolean' },
        {
          key: 'statusCard',
          label: 'Status Card',
          kind: 'object',
          properties: [{ key: 'enabled', label: 'Enabled', kind: 'boolean' }],
        },
        {
          key: 'questionCard',
          label: 'Question Card',
          kind: 'object',
          properties: [
            { key: 'enabled', label: 'Enabled', kind: 'boolean' },
            {
              key: 'timeoutMs',
              label: 'Timeout (ms)',
              kind: 'number',
              exclusiveMinimum: 0,
            },
          ],
        },
        {
          key: 'permissionCard',
          label: 'Permission Card',
          kind: 'object',
          properties: [
            { key: 'enabled', label: 'Enabled', kind: 'boolean' },
            {
              key: 'timeoutMs',
              label: 'Timeout (ms)',
              kind: 'number',
              exclusiveMinimum: 0,
            },
          ],
        },
      ],
    });
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

  it('rejects qualified channel mutations for the Conversations runtime', async () => {
    const primary = runtime('primary', '/work/primary');
    const live = runtime(
      'conversations',
      '/work/Conversations',
      true,
      'live-conversation',
    );
    const liveService = service();
    const resolveService = vi.fn((target: WorkspaceRuntime) =>
      target === live ? liveService : service(),
    );
    const app = express();
    app.use(express.json());
    registerWorkspaceChannelManagementRoutes(app, {
      primaryRuntime: primary,
      workspaceRegistry: createWorkspaceRegistry([primary, live]),
      resolveService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      parseAndValidateClientId: () => undefined,
    });

    const response = await request(app)
      .put('/workspaces/conversations/channels/bot')
      .send({ expectedRevision: 'r1', config: { type: 'dingtalk' } });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('live_channel_management_reserved');
    expect(resolveService).not.toHaveBeenCalled();
    expect(liveService.upsert).not.toHaveBeenCalled();
  });

  it('fails closed before internal channel reads when the activity gate is absent', async () => {
    const primary = runtime('primary', '/work/primary');
    const live = runtime(
      'conversations',
      '/work/Conversations',
      true,
      'live-conversation',
    );
    const liveService = service();
    const resolveService = vi.fn(() => liveService);
    const app = express();
    app.use(express.json());
    registerWorkspaceChannelManagementRoutes(app, {
      primaryRuntime: primary,
      workspaceRegistry: createWorkspaceRegistry([primary, live]),
      resolveService,
      mutate: () => (_req, _res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      parseAndValidateClientId: () => undefined,
    });

    const response = await request(app).get(
      '/workspaces/conversations/channels',
    );

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('conversation_runtime_unavailable');
    expect(resolveService).not.toHaveBeenCalled();
    expect(liveService.list).not.toHaveBeenCalled();
  });

  it('fails closed for an untrusted secondary workspace', async () => {
    const { app, primaryService, secondaryService } = mount(false);

    const response = await request(app).get('/workspaces/secondary/channels');
    const approvals = await auth(
      request(app).get('/workspaces/secondary/channels/bot/pairing-approvals'),
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(approvals.status).toBe(403);
    expect(approvals.body.code).toBe('untrusted_workspace');
    expect(primaryService.list).not.toHaveBeenCalled();
    expect(secondaryService.list).not.toHaveBeenCalled();
    expect(secondaryService.pairingApprovals).not.toHaveBeenCalled();
  });

  it('returns 503 when the channel management service is unavailable', async () => {
    const primary = runtime('primary', '/work/primary');
    const app = express();
    app.use(express.json());
    registerWorkspaceChannelManagementRoutes(app, {
      primaryRuntime: primary,
      workspaceRegistry: createWorkspaceRegistry([primary]),
      resolveService: () => undefined,
      mutate: () => (req, res, next) => next(),
      safeBody: (req) => (req.body ?? {}) as Record<string, unknown>,
      parseAndValidateClientId: () => undefined,
    });

    const response = await request(app).get('/workspace/channels');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('channel_management_unavailable');
  });

  it('manages pairing requests and approvals in the selected workspace', async () => {
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
    await request(app)
      .get('/workspaces/secondary/channels/bot/pairing-approvals')
      .expect(401);
    await request(app)
      .delete('/workspaces/secondary/channels/bot/pairing-approvals')
      .send({ senderId: 'sender-1' })
      .expect(401);
    const approvals = await auth(
      request(app).get('/workspaces/secondary/channels/bot/pairing-approvals'),
    );
    const revocation = await auth(
      request(app)
        .delete('/workspaces/secondary/channels/bot/pairing-approvals')
        .send({ senderId: 'sender-1' }),
    );

    expect(pairingRequests.status).toBe(200);
    expect(pairingRequests.headers['cache-control']).toBe('no-store');
    expect(pairingRequests.body).toEqual({ requests: [] });
    expect(approval.status).toBe(200);
    expect(approval.headers['cache-control']).toBe('no-store');
    expect(approval.body).toEqual({
      approved: {
        senderId: 'sender-1',
        senderName: 'Alice',
        subject: { type: 'user', id: 'sender-1', name: 'Alice' },
        code: 'ABCDEFGH',
        createdAt: 1,
      },
      requests: [],
    });
    expect(approvals.status).toBe(200);
    expect(approvals.headers['cache-control']).toBe('no-store');
    expect(approvals.body).toEqual({
      senderIds: ['sender-1'],
      groupIds: ['group-1'],
    });
    expect(revocation.status).toBe(200);
    expect(revocation.headers['cache-control']).toBe('no-store');
    expect(revocation.body).toEqual({
      revoked: 'sender-1',
      senderIds: [],
      groupIds: [],
    });
    expect(secondaryService.pairingRequests).toHaveBeenCalledWith('bot');
    expect(secondaryService.approvePairing).toHaveBeenCalledWith(
      'bot',
      'ABCDEFGH',
    );
    expect(secondaryService.pairingApprovals).toHaveBeenCalledWith('bot');
    expect(secondaryService.revokePairingApproval).toHaveBeenCalledWith('bot', {
      type: 'user',
      id: 'sender-1',
    });
    expect(primaryService.pairingRequests).not.toHaveBeenCalled();
    expect(primaryService.pairingApprovals).not.toHaveBeenCalled();

    const primaryPairingRequests = await auth(
      request(app).get('/workspace/channels/bot/pairing-requests'),
    );
    expect(primaryPairingRequests.status).toBe(200);
    expect(primaryService.pairingRequests).toHaveBeenCalledWith('bot');
  });

  it('revokes a group pairing approval by stable group ID', async () => {
    const { app, secondaryService } = mount();

    const response = await auth(
      request(app)
        .delete('/workspaces/secondary/channels/bot/pairing-approvals')
        .send({ groupId: 'group-1' }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      revoked: 'group-1',
      senderIds: [],
      groupIds: [],
    });
    expect(secondaryService.revokePairingApproval).toHaveBeenCalledWith('bot', {
      type: 'group',
      id: 'group-1',
    });
  });

  it('returns 404 when a pairing approval no longer exists', async () => {
    const { app, primaryService } = mount();
    vi.mocked(primaryService.revokePairingApproval).mockRejectedValueOnce(
      Object.assign(new Error('Pairing approval was not found.'), {
        code: 'channel_pairing_approval_not_found',
      }),
    );

    const response = await auth(
      request(app)
        .delete('/workspace/channels/bot/pairing-approvals')
        .send({ senderId: 'sender-1' }),
    );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('channel_pairing_approval_not_found');
  });

  it('rejects requests with an invalid client ID', async () => {
    const { app, primaryService } = mount();
    const invalidClient = (test: request.Test) =>
      test
        .set('Authorization', 'Bearer secret')
        .set('X-Qwen-Client-Id', 'invalid');

    const list = await invalidClient(request(app).get('/workspace/channels'));
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
    const restart = await invalidClient(
      request(app).post('/workspace/channels/bot/restart'),
    );
    const startup = await invalidClient(
      request(app)
        .put('/workspace/channels/bot/startup')
        .send({ expectedRevision: 'r1', enabled: true }),
    );
    const approve = await invalidClient(
      request(app)
        .post('/workspace/channels/bot/pairing-requests/approve')
        .send({ code: 'ABCDEFGH' }),
    );
    const pairingRequests = await invalidClient(
      request(app).get('/workspace/channels/bot/pairing-requests'),
    );
    const pairingApprovals = await invalidClient(
      request(app).get('/workspace/channels/bot/pairing-approvals'),
    );
    const revokePairingApproval = await invalidClient(
      request(app)
        .delete('/workspace/channels/bot/pairing-approvals')
        .send({ senderId: 'sender-1' }),
    );

    expect(list.status).toBe(400);
    expect(list.body.code).toBe('invalid_client_id');
    expect(upsert.status).toBe(400);
    expect(upsert.body.code).toBe('invalid_client_id');
    expect(remove.status).toBe(400);
    expect(start.status).toBe(400);
    expect(stop.status).toBe(400);
    expect(restart.status).toBe(400);
    expect(startup.status).toBe(400);
    expect(approve.status).toBe(400);
    expect(pairingRequests.status).toBe(400);
    expect(pairingApprovals.status).toBe(400);
    expect(revokePairingApproval.status).toBe(400);
    expect(primaryService.list).not.toHaveBeenCalled();
    expect(primaryService.upsert).not.toHaveBeenCalled();
    expect(primaryService.remove).not.toHaveBeenCalled();
    expect(primaryService.start).not.toHaveBeenCalled();
    expect(primaryService.stop).not.toHaveBeenCalled();
    expect(primaryService.restart).not.toHaveBeenCalled();
    expect(primaryService.setStartup).not.toHaveBeenCalled();
    expect(primaryService.approvePairing).not.toHaveBeenCalled();
    expect(primaryService.pairingRequests).not.toHaveBeenCalled();
    expect(primaryService.pairingApprovals).not.toHaveBeenCalled();
    expect(primaryService.revokePairingApproval).not.toHaveBeenCalled();
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
    const invalidSenderId = await auth(
      request(app)
        .delete('/workspace/channels/bot/pairing-approvals')
        .send({ senderId: '' }),
    );
    const invalidGroupId = await auth(
      request(app)
        .delete('/workspace/channels/bot/pairing-approvals')
        .send({ groupId: '' }),
    );
    const ambiguousSubject = await auth(
      request(app)
        .delete('/workspace/channels/bot/pairing-approvals')
        .send({ senderId: 'sender-1', groupId: 'group-1' }),
    );
    const missingSubject = await auth(
      request(app).delete('/workspace/channels/bot/pairing-approvals').send({}),
    );

    expect(invalidName.body.code).toBe('invalid_channel_instance_name');
    expect(unsafeName.status).toBe(400);
    expect(unsafeName.body.code).toBe('channel_settings_invalid_name');
    expect(invalidRevision.body.code).toBe(
      'invalid_channel_management_request',
    );
    expect(invalidSecret.body.code).toBe('channel_settings_invalid_secret');
    expect(invalidPairing.body.code).toBe('invalid_channel_pairing_code');
    expect(invalidSenderId.body.code).toBe('invalid_channel_pairing_sender_id');
    expect(invalidGroupId.body.code).toBe('invalid_channel_pairing_group_id');
    expect(ambiguousSubject.body.code).toBe('invalid_channel_pairing_subject');
    expect(missingSubject.status).toBe(400);
    expect(missingSubject.body.code).toBe('invalid_channel_pairing_subject');
    expect(primaryService.upsert).toHaveBeenCalledOnce();
    expect(primaryService.start).not.toHaveBeenCalled();
    expect(primaryService.approvePairing).not.toHaveBeenCalled();
    expect(primaryService.revokePairingApproval).not.toHaveBeenCalled();
  });

  it('sends only the name error when both name and body are invalid', async () => {
    const { app, primaryService } = mount();

    const approve = await auth(
      request(app)
        .post('/workspace/channels/a%2Fb/pairing-requests/approve')
        .send({ code: 'short' }),
    );
    const revoke = await auth(
      request(app)
        .delete('/workspace/channels/a%2Fb/pairing-approvals')
        .send({ senderId: '' }),
    );
    const upsert = await auth(
      request(app)
        .put('/workspace/channels/a%2Fb')
        .send({ expectedRevision: '' }),
    );
    const remove = await auth(
      request(app)
        .delete('/workspace/channels/a%2Fb')
        .send({ expectedRevision: '' }),
    );
    const startup = await auth(
      request(app)
        .put('/workspace/channels/a%2Fb/startup')
        .send({ expectedRevision: '' }),
    );

    expect(approve.status).toBe(400);
    expect(approve.body.code).toBe('invalid_channel_instance_name');
    expect(revoke.status).toBe(400);
    expect(revoke.body.code).toBe('invalid_channel_instance_name');
    expect(upsert.status).toBe(400);
    expect(upsert.body.code).toBe('invalid_channel_instance_name');
    expect(remove.status).toBe(400);
    expect(remove.body.code).toBe('invalid_channel_instance_name');
    expect(startup.status).toBe(400);
    expect(startup.body.code).toBe('invalid_channel_instance_name');
    expect(primaryService.approvePairing).not.toHaveBeenCalled();
    expect(primaryService.revokePairingApproval).not.toHaveBeenCalled();
    expect(primaryService.upsert).not.toHaveBeenCalled();
    expect(primaryService.remove).not.toHaveBeenCalled();
    expect(primaryService.setStartup).not.toHaveBeenCalled();
  });
});

describe('workspace Channel event journal', () => {
  let qwenHome: string;
  let savedQwenHome: string | undefined;

  beforeEach(() => {
    savedQwenHome = process.env['QWEN_HOME'];
    qwenHome = mkdtempSync(join(tmpdir(), 'channel-events-route-'));
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(() => {
    rmSync(qwenHome, { recursive: true, force: true });
    if (savedQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = savedQwenHome;
  });

  function append(cwd: string, index: number, channel = 'bot') {
    const inbound = index % 2 === 0;
    appendChannelEvent(channel, cwd, {
      at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      type: inbound ? 'inbound' : 'poll',
      outcome: inbound ? 'skipped' : 'ok',
      ...(inbound ? { reason: 'reason_filter' } : {}),
      repository: 'owner/repo',
      number: 42,
    });
  }

  it('serves a workspace journal newest-last without operator auth', async () => {
    const { app } = mount();
    append('/work/primary', 1);
    append('/work/primary', 2);
    append('/work/primary', 3, 'other');

    const response = await request(app).get(
      '/workspace/channels/events?limit=2',
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.truncated).toBe(true);
    expect(response.body.events).toHaveLength(2);
    expect(response.body.events.at(-1)).toMatchObject({
      channel: 'other',
      type: 'poll',
      outcome: 'ok',
    });
  });

  it('filters by type and channel', async () => {
    const { app } = mount();
    append('/work/primary', 1);
    append('/work/primary', 2);

    const byType = await request(app).get(
      '/workspace/channels/events?type=inbound',
    );
    expect(byType.body.events).toHaveLength(1);
    expect(byType.body.events[0].reason).toBe('reason_filter');

    const byChannel = await request(app).get(
      '/workspace/channels/events?channel=other',
    );
    expect(byChannel.body.events).toEqual([]);
  });

  it('takes one repeatable parameter per channel name, commas included', async () => {
    const { app } = mount();
    append('/work/primary', 1, 'bot');
    append('/work/primary', 2, 'a,b');
    append('/work/primary', 3, 'other');

    const repeated = await request(app).get(
      '/workspace/channels/events?channel=bot&channel=other',
    );
    expect(
      repeated.body.events.map((event: { channel: string }) => event.channel),
    ).toEqual(['bot', 'other']);

    const commaNamed = await request(app).get(
      '/workspace/channels/events?channel=a%2Cb',
    );
    expect(commaNamed.body.events).toHaveLength(1);
    expect(commaNamed.body.events[0].channel).toBe('a,b');
  });

  it('reads only the resolved workspace scope', async () => {
    const { app } = mount();
    append('/work/primary', 1);
    append('/work/secondary', 2);

    const primary = await request(app).get('/workspace/channels/events');
    const secondary = await request(app).get(
      '/workspaces/secondary/channels/events',
    );

    expect(primary.body.events).toHaveLength(1);
    expect(secondary.body.events).toHaveLength(1);
    expect(primary.body.events[0].at).not.toBe(secondary.body.events[0].at);
  });

  it('does not serve an untrusted workspace journal', async () => {
    const { app } = mount(false);
    const response = await request(app).get(
      '/workspaces/secondary/channels/events',
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ['limit=0', '`limit` must be a positive integer.'],
    ['type=bogus', '`type` accepts only: inbound, outbound, task, poll.'],
    ['since=yesterday', '`since` must be an ISO 8601 timestamp.'],
  ])('rejects %s with 400', async (query, message) => {
    const { app } = mount();
    const response = await request(app).get(
      `/workspace/channels/events?${query}`,
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_channel_management_request');
    expect(response.body.error).toBe(message);
  });

  it('clamps an oversized limit to the maximum page', async () => {
    const { app } = mount();
    const path = channelEventFilePath('bot', '/work/primary');
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      at: new Date(2026, 0, 1).toISOString(),
      channel: 'bot',
      type: 'poll',
      outcome: 'ok',
    });
    writeFileSync(path, `${line}\n`.repeat(501));

    const response = await request(app).get(
      '/workspace/channels/events?limit=100000',
    );

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(500);
    expect(response.body.truncated).toBe(true);
  });

  it('reports a failure instead of an empty journal when the scope is unreadable', async () => {
    const { app } = mount();
    append('/work/primary', 1);
    const dir = channelEventScopeDir('/work/primary');
    chmodSync(dir, 0o000);
    try {
      const response = await request(app).get('/workspace/channels/events');
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('channel_management_failed');
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('attaches link metadata for a user-scope channel owned by the workspace', async () => {
    // The documented GitHub setup: the channel lives in user settings with
    // cwd pointing at the project, so the scope-local management listing
    // has no entry for it even though its journal rows appear here.
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'my-github': {
            type: 'github',
            token: 'super-secret',
            baseUrl: 'https://ghe.example.com/api/v3',
            cwd: '/work/primary',
          },
        },
      }),
    );
    const { app } = mount();
    append('/work/primary', 1, 'my-github');

    const response = await request(app).get('/workspace/channels/events');

    expect(response.status).toBe(200);
    expect(response.body.channelLinkMeta).toEqual({
      'my-github': {
        type: 'github',
        baseUrl: 'https://ghe.example.com/api/v3',
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('super-secret');
  });

  it('keeps link metadata workspace-isolated by channel cwd', async () => {
    writeFileSync(
      join(qwenHome, 'settings.json'),
      JSON.stringify({
        channels: {
          'primary-gh': { type: 'github', cwd: '/work/primary' },
          'secondary-gh': { type: 'github', cwd: '/work/secondary' },
        },
      }),
    );
    const { app } = mount();
    append('/work/primary', 1, 'primary-gh');
    append('/work/primary', 2, 'secondary-gh');
    append('/work/secondary', 3, 'secondary-gh');

    const primary = await request(app).get('/workspace/channels/events');
    const secondary = await request(app).get(
      '/workspaces/secondary/channels/events',
    );

    expect(primary.body.channelLinkMeta).toEqual({
      'primary-gh': { type: 'github' },
    });
    expect(secondary.body.channelLinkMeta).toEqual({
      'secondary-gh': { type: 'github' },
    });
  });

  it('omits link metadata when no journal channel resolves in the merged settings', async () => {
    const { app } = mount();
    append('/work/primary', 1, 'deleted-channel');

    const response = await request(app).get('/workspace/channels/events');

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body).not.toHaveProperty('channelLinkMeta');
  });

  it('still serves the journal when link metadata resolution fails', async () => {
    vi.mocked(channelLinkMetaForEvents).mockImplementationOnce(() => {
      throw new Error('settings unavailable');
    });
    const { app } = mount();
    append('/work/primary', 1);

    const response = await request(app).get('/workspace/channels/events');

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body).not.toHaveProperty('channelLinkMeta');
  });

  it('never loads the workspace .env into the daemon process environment', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'channel-link-meta-ws-'));
    const sentinel = 'QWEN_LINK_META_SENTINEL';
    const savedSentinel = process.env[sentinel];
    delete process.env[sentinel];
    try {
      mkdirSync(join(ws, '.qwen'), { recursive: true });
      writeFileSync(join(ws, '.env'), `${sentinel}=leaked-from-workspace\n`);
      writeFileSync(
        join(ws, '.qwen', '.env'),
        `${sentinel}=leaked-from-workspace\n`,
      );
      writeFileSync(
        join(ws, '.qwen', 'settings.json'),
        JSON.stringify({ channels: { 'ws-gh': { type: 'github' } } }),
      );
      const { app } = mount(true, { cwd: ws });
      append(ws, 1, 'ws-gh');

      const response = await request(app).get('/workspace/channels/events');

      expect(response.status).toBe(200);
      expect(response.body.channelLinkMeta).toEqual({
        'ws-gh': { type: 'github' },
      });
      expect(process.env[sentinel]).toBeUndefined();
    } finally {
      if (savedSentinel === undefined) delete process.env[sentinel];
      else process.env[sentinel] = savedSentinel;
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('leaves a corrupt workspace settings file untouched and degrades', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'channel-link-meta-corrupt-'));
    try {
      mkdirSync(join(ws, '.qwen'), { recursive: true });
      const corrupt = '{"channels": ';
      const settingsPath = join(ws, '.qwen', 'settings.json');
      writeFileSync(settingsPath, corrupt);
      const { app } = mount(true, { cwd: ws });
      append(ws, 1, 'ws-gh');

      const response = await request(app).get('/workspace/channels/events');

      expect(response.status).toBe(200);
      expect(response.body.events).toHaveLength(1);
      expect(response.body).not.toHaveProperty('channelLinkMeta');
      expect(readFileSync(settingsPath, 'utf8')).toBe(corrupt);
      expect(existsSync(`${settingsPath}.corrupted`)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('resolves metadata against the runtime effective environment', async () => {
    const overlayHome = mkdtempSync(join(tmpdir(), 'channel-link-meta-env-'));
    try {
      // The process QWEN_HOME (qwenHome) configures no channels; only the
      // runtime overlay's home does, so a process-env read would find nothing.
      writeFileSync(
        join(overlayHome, 'settings.json'),
        JSON.stringify({
          channels: {
            'overlay-gh': {
              type: 'github',
              baseUrl: 'https://overlay.example/api/v3',
            },
          },
        }),
      );
      const { app } = mount(true, {
        env: {
          mode: 'runtime-overlay',
          overlayKeys: ['QWEN_HOME'],
          effectiveEnv: { ...process.env, QWEN_HOME: overlayHome },
        },
      });
      append('/work/primary', 1, 'overlay-gh');

      const response = await request(app).get('/workspace/channels/events');

      expect(response.status).toBe(200);
      expect(response.body.channelLinkMeta).toEqual({
        'overlay-gh': {
          type: 'github',
          baseUrl: 'https://overlay.example/api/v3',
        },
      });
    } finally {
      rmSync(overlayHome, { recursive: true, force: true });
    }
  });
});
