/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QWEN_SUBSCRIPTION_BASE_URL } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import { registerWorkspaceSubscriptionRoutes } from './workspace-subscription.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import {
  createWorkspaceRegistry,
  createWorkspaceGenerationGuard,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { SettingScope } from '../../config/settings.js';

const mocks = vi.hoisted(() => ({
  userInfo: vi.fn(),
  models: vi.fn(),
  loadSettings: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getUserInfo = mocks.userInfo;
    getModels = mocks.models;
  },
}));
vi.mock('../../config/settings.js', async (original) => ({
  ...(await original<typeof import('../../config/settings.js')>()),
  loadSettings: mocks.loadSettings,
}));
beforeEach(() => {
  vi.stubEnv('DEV', true);
  process.env['DEV'] = 'true';
  mocks.userInfo.mockReset().mockResolvedValue({ member_type: 'pro' });
  mocks.models
    .mockReset()
    .mockResolvedValue({ models: ['qwen3.8-max'], cached: false });
  mocks.loadSettings.mockReturnValue({ merged: {} });
});
afterEach(() => vi.unstubAllEnvs());
function setup(trusted = true) {
  const guard = createWorkspaceGenerationGuard();
  const reloadModelProviders = vi.fn().mockResolvedValue({ status: 'applied' });
  const runtime = {
    workspaceId: 'secondary',
    workspaceCwd: '/secondary',
    primary: false,
    trusted,
    removable: true,
    bridge: { knownClientIds: () => new Set<string>() },
    generationGuard: guard,
    workspaceService: { reloadModelProviders },
  } as unknown as WorkspaceRuntime;
  const persistSettings = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  registerWorkspaceSubscriptionRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([
      {
        ...runtime,
        workspaceId: 'primary',
        workspaceCwd: '/primary',
        primary: true,
        trusted: true,
        workspaceService: { reloadModelProviders: vi.fn() },
      } as unknown as WorkspaceRuntime,
      runtime,
    ]),
    mutate: () => (_req, _res, next) => next(),
    persistSettings,
    sendBridgeError: (res) => {
      res.status(409).json({ code: 'runtime_unavailable' });
    },
  });
  return { app, guard, persistSettings, reloadModelProviders };
}
it('rejects an unregistered first-login client ID before account activation', async () => {
  const { app, persistSettings, reloadModelProviders } = setup();
  const response = await request(app)
    .post('/workspaces/secondary/auth/subscription')
    .set('X-Qwen-Client-Id', 'unregistered-vscode-client')
    .send({});
  expect(response.status).toBe(400);
  expect(response.body.code).toBe('invalid_client_id');
  expect(mocks.userInfo).not.toHaveBeenCalled();
  expect(persistSettings).not.toHaveBeenCalled();
  expect(reloadModelProviders).not.toHaveBeenCalled();
});

it.each([
  ['userinfo', 'refresh', 'invalid_grant', 400, 'Your session has expired.'],
  [
    'userinfo',
    'userinfo',
    'rate_limited',
    429,
    'Please wait before checking membership.',
  ],
  [
    'models',
    undefined,
    'request_failed',
    403,
    'Your account cannot access this model catalog.',
  ],
  ['userinfo', 'userinfo', 'invalid_response', 200, undefined],
] as const)(
  'preserves %s failures during activation (%s)',
  async (operation, stage, code, status, message) => {
    const { app, persistSettings } = setup();
    mocks[operation === 'userinfo' ? 'userInfo' : 'models'].mockRejectedValue(
      new SubscriptionOAuthError(code, status, message, 30_000, stage),
    );
    const response = await request(app).post(
      '/workspaces/secondary/auth/subscription',
    );
    expect(response.status).toBe(status >= 400 ? status : 502);
    expect(response.body).toMatchObject({
      code,
      ...(message ? { message } : {}),
      errorStatus: status,
      errorStage: stage ?? 'models',
      retryAfterMs: 30_000,
    });
    expect(persistSettings).not.toHaveBeenCalled();
  },
);

it('activates only the selected runtime using workspace-scoped non-secret settings', async () => {
  const { app, persistSettings, reloadModelProviders } = setup();
  const response = await request(app)
    .post('/workspaces/secondary/auth/subscription')
    .send({ baseUrl: 'https://other.example', apiKey: 'ignored' });
  expect(response.status).toBe(200);
  expect(persistSettings).toHaveBeenCalledWith(
    '/secondary',
    [
      {
        scope: SettingScope.Workspace,
        key: 'security.auth.selectedType',
        value: 'qwen-subscription',
      },
      {
        scope: SettingScope.Workspace,
        key: 'model.name',
        value: 'qwen3.8-max',
      },
      {
        scope: SettingScope.Workspace,
        key: 'model.baseUrl',
        value: QWEN_SUBSCRIPTION_BASE_URL,
      },
    ],
    expect.any(Function),
  );
  expect(reloadModelProviders).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceCwd: '/secondary' }),
  );
  expect(response.body).toEqual({
    authType: 'qwen-subscription',
    modelId: 'qwen3.8-max',
    runtimeSync: { status: 'applied' },
  });
});

it('keeps local activation failures structured without exposing exception details', async () => {
  const { app, persistSettings } = setup();
  mocks.userInfo.mockRejectedValue(
    new SubscriptionOAuthError(
      'credentials_error',
      undefined,
      '/private/path/private-test-token',
      undefined,
      'credentials',
    ),
  );
  const response = await request(app).post(
    '/workspaces/secondary/auth/subscription',
  );
  expect(response.status).toBe(502);
  expect(response.body).toEqual({
    code: 'credentials_error',
    errorStage: 'credentials',
  });
  expect(persistSettings).not.toHaveBeenCalled();
});
it.each(['plus', 'pro', 'PLUS', 'Pro', 'pLuS'])(
  'accepts %s membership regardless of casing',
  async (member_type) => {
    const { app } = setup();
    mocks.userInfo.mockResolvedValue({ member_type });
    const response = await request(app).post(
      '/workspaces/secondary/auth/subscription',
    );
    expect(response.status).toBe(200);
  },
);
it.each(['free', 'lite', 'FREE', 'LITE', 'future-plan'])(
  'rejects %s membership before persisting',
  async (member_type) => {
    const { app, persistSettings, reloadModelProviders } = setup();
    mocks.userInfo.mockResolvedValue({ member_type });
    expect(
      (await request(app).post('/workspaces/secondary/auth/subscription'))
        .status,
    ).toBe(403);
    expect(persistSettings).not.toHaveBeenCalled();
    expect(reloadModelProviders).not.toHaveBeenCalled();
  },
);

it('activates the server default without requiring Max', async () => {
  const { app, persistSettings } = setup();
  mocks.models.mockResolvedValue({ models: ['future-model'], cached: false });
  const response = await request(app).post(
    '/workspaces/secondary/auth/subscription',
  );
  expect(response.status).toBe(200);
  expect(response.body.modelId).toBe('future-model');
  expect(persistSettings.mock.calls[0][1]).toContainEqual({
    scope: SettingScope.Workspace,
    key: 'model.name',
    value: 'future-model',
  });
});
it('does not fall back for an unknown or untrusted workspace', async () => {
  const { app, persistSettings } = setup(false);
  expect(
    (await request(app).post('/workspaces/secondary/auth/subscription')).status,
  ).toBe(403);
  expect(
    (await request(app).post('/workspaces/unknown/auth/subscription')).status,
  ).not.toBe(200);
  expect(persistSettings).not.toHaveBeenCalled();
  expect(mocks.userInfo).not.toHaveBeenCalled();
});
it('respects the development gate and enforced authentication policy', async () => {
  const { app, persistSettings } = setup();
  vi.stubEnv('DEV', false);
  process.env['DEV'] = 'false';
  expect(
    (await request(app).post('/workspaces/secondary/auth/subscription')).status,
  ).toBe(404);
  vi.stubEnv('DEV', true);
  process.env['DEV'] = 'true';
  mocks.models
    .mockReset()
    .mockResolvedValue({ models: ['qwen3.8-max'], cached: false });
  mocks.loadSettings.mockReturnValue({
    merged: { security: { auth: { enforcedType: 'openai' } } },
  });
  expect(
    (await request(app).post('/workspaces/secondary/auth/subscription')).body
      .code,
  ).toBe('auth_type_enforced');
  expect(persistSettings).not.toHaveBeenCalled();
});
it('does not persist after the generation closes during membership lookup', async () => {
  const { app, persistSettings, guard } = setup();
  mocks.userInfo.mockImplementation(async () => {
    guard.close();
    return { member_type: 'pro' };
  });
  expect(
    (await request(app).post('/workspaces/secondary/auth/subscription')).status,
  ).toBe(409);
  expect(persistSettings).not.toHaveBeenCalled();
});
it.each(['failed', 'deferred'])(
  'preserves %s runtime sync status',
  async (status) => {
    const { app, reloadModelProviders } = setup();
    reloadModelProviders.mockResolvedValue({ status });
    const response = await request(app).post(
      '/workspaces/secondary/auth/subscription',
    );
    expect(response.body.runtimeSync.status).toBe(status);
  },
);

it('preserves a removed selection and recovers after the saved model is changed', async () => {
  const { app, persistSettings } = setup();
  mocks.models.mockResolvedValue({ models: ['replacement'], cached: false });
  mocks.loadSettings.mockReturnValue({
    merged: {
      security: { auth: { selectedType: 'qwen-subscription' } },
      model: { name: 'removed' },
    },
  });
  const unavailable = await request(app).post(
    '/workspaces/secondary/auth/subscription',
  );
  expect(unavailable.status).toBe(409);
  expect(unavailable.body).toEqual({
    code: 'subscription_model_unavailable',
  });
  expect(persistSettings).not.toHaveBeenCalled();
  mocks.loadSettings.mockReturnValue({
    merged: {
      security: { auth: { selectedType: 'qwen-subscription' } },
      model: { name: 'replacement' },
    },
  });
  const selected = await request(app).post(
    '/workspaces/secondary/auth/subscription',
  );
  expect(selected.status).toBe(200);
  expect(selected.body.modelId).toBe('replacement');
});
