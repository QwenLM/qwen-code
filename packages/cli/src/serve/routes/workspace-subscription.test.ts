/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import request from 'supertest';
import { homedir } from 'node:os';
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
  vi.stubEnv('DEV', false);
  delete process.env['DEV'];
  mocks.userInfo.mockReset().mockResolvedValue({ member_type: 'pro' });
  mocks.models
    .mockReset()
    .mockResolvedValue({ models: ['qwen3.8-max'], cached: false });
  mocks.loadSettings.mockReset().mockReturnValue({
    merged: {},
    isTrusted: true,
    workspaceSettingsActive: true,
    workspace: { settings: { modelProviders: {} } },
    user: { settings: {} },
  });
});
afterEach(() => vi.unstubAllEnvs());
function setup(trusted = true) {
  const guard = createWorkspaceGenerationGuard();
  const primaryGuard = createWorkspaceGenerationGuard();
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
    qwenCodeVersion: '0.0.0-test',
    workspaceRegistry: createWorkspaceRegistry([
      {
        ...runtime,
        workspaceId: 'primary',
        workspaceCwd: '/primary',
        primary: true,
        trusted: true,
        generationGuard: primaryGuard,
        workspaceService: { reloadModelProviders: vi.fn() },
      } as unknown as WorkspaceRuntime,
      runtime,
    ]),
    mutate: () => (_req, _res, next) => next(),
    persistSettings: async (cwd, writes, assertGenerationOpen) => {
      assertGenerationOpen?.();
      const fresh = mocks.loadSettings(cwd);
      await persistSettings(
        cwd,
        typeof writes === 'function' ? writes(fresh) : writes,
        assertGenerationOpen,
      );
    },
    sendBridgeError: (res) => {
      res.status(409).json({ code: 'runtime_unavailable' });
    },
  });
  return { app, guard, primaryGuard, persistSettings, reloadModelProviders };
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

it.each([
  ['project', { modelProviders: {} }, 'provider', SettingScope.Workspace],
  [
    'user',
    { security: { auth: { selectedType: 'openai' } }, model: { name: 'api' } },
    'provider',
    SettingScope.User,
  ],
  ['fresh', {}, 'provider', SettingScope.User],
  ['VS Code user default', { modelProviders: {} }, 'user', SettingScope.User],
  ['legacy workspace default', {}, undefined, SettingScope.Workspace],
] as const)(
  'persists the subscription for the %s case',
  async (_label, project, settingsScope, scope) => {
    mocks.loadSettings.mockImplementation((cwd: string) => ({
      merged: {},
      isTrusted: true,
      workspaceSettingsActive: true,
      workspace: {
        settings:
          settingsScope !== 'provider' || cwd === '/primary'
            ? project
            : Object.hasOwn(project, 'modelProviders')
              ? {}
              : { modelProviders: {} },
      },
      user: { settings: { modelProviders: {} } },
    }));
    const { app, persistSettings, reloadModelProviders } = setup();
    const response = await request(app)
      .post('/workspaces/secondary/auth/subscription')
      .send({
        settingsScope,
        baseUrl: 'https://other.example',
        apiKey: 'ignored',
      });
    expect(response.status).toBe(200);
    expect(mocks.models).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      '0.0.0-test',
    );
    expect(persistSettings).toHaveBeenCalledWith(
      settingsScope === 'provider' ? '/primary' : '/secondary',
      [
        {
          scope,
          key: 'security.auth.selectedType',
          value: 'qwen-subscription',
        },
        {
          scope,
          key: 'model.name',
          value: 'qwen3.8-max',
        },
        {
          scope,
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
  },
);

it.each(['catalog', 'policy'] as const)(
  'uses the updated project %s after account lookup',
  async (change) => {
    const { app, persistSettings } = setup();
    const initial = {
      merged: {},
      isTrusted: true,
      workspaceSettingsActive: true,
      workspace: { settings: {} },
      user: { settings: { modelProviders: {} } },
    };
    mocks.loadSettings.mockReturnValue(initial);
    mocks.models.mockImplementation(async () => {
      mocks.loadSettings.mockImplementation((cwd: string) =>
        change === 'catalog' && cwd === '/primary'
          ? { ...initial, workspace: { settings: { modelProviders: {} } } }
          : change === 'policy' && cwd === '/secondary'
            ? {
                ...initial,
                merged: { security: { auth: { enforcedType: 'openai' } } },
              }
            : initial,
      );
      return { models: ['qwen3.8-max'], cached: false };
    });

    const response = await request(app)
      .post('/workspaces/secondary/auth/subscription')
      .send({ settingsScope: 'provider' });

    if (change === 'policy') {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('auth_type_enforced');
      expect(persistSettings).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(persistSettings).toHaveBeenCalledExactlyOnceWith(
        '/primary',
        ['security.auth.selectedType', 'model.name', 'model.baseUrl'].map(
          (key) =>
            expect.objectContaining({ scope: SettingScope.Workspace, key }),
        ),
        expect.any(Function),
      );
    }
  },
);

it('selects the account model using global settings only', async () => {
  const { app, persistSettings, reloadModelProviders } = setup();
  const response = await request(app).post('/auth/subscription/model');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ modelId: 'qwen3.8-max' });
  expect(mocks.loadSettings).toHaveBeenCalledExactlyOnceWith(homedir(), {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: true,
    workspaceTrusted: true,
  });
  expect(persistSettings).not.toHaveBeenCalled();
  expect(reloadModelProviders).not.toHaveBeenCalled();
});

it.each([SettingScope.User, SettingScope.Workspace])(
  'saves the standalone Desktop selection using the primary settings (%s)',
  async (scope) => {
    const { app, persistSettings, reloadModelProviders } = setup();
    mocks.loadSettings.mockReturnValue({
      merged: {},
      isTrusted: true,
      workspace: {
        settings:
          scope === SettingScope.Workspace ? { modelProviders: {} } : {},
      },
      user: { settings: {} },
    });
    const response = await request(app)
      .post('/auth/subscription/model')
      .send({ settingsScope: 'provider' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ modelId: 'qwen3.8-max' });
    expect(persistSettings).toHaveBeenCalledExactlyOnceWith(
      '/primary',
      [
        {
          scope,
          key: 'security.auth.selectedType',
          value: 'qwen-subscription',
        },
        { scope, key: 'model.name', value: 'qwen3.8-max' },
        {
          scope,
          key: 'model.baseUrl',
          value: QWEN_SUBSCRIPTION_BASE_URL,
        },
      ],
      expect.any(Function),
    );
    expect(reloadModelProviders).not.toHaveBeenCalled();
  },
);

it('rejects account model discovery under a global authentication policy', async () => {
  const { app, persistSettings, reloadModelProviders } = setup();
  mocks.loadSettings.mockReturnValue({
    workspaceSettingsActive: false,
    merged: { security: { auth: { enforcedType: 'openai' } } },
  });
  const response = await request(app)
    .post('/auth/subscription/model')
    .send({ settingsScope: 'provider' });

  expect(response.status).toBe(403);
  expect(response.body.code).toBe('auth_type_enforced');
  expect(mocks.userInfo).not.toHaveBeenCalled();
  expect(mocks.models).not.toHaveBeenCalled();
  expect(persistSettings).not.toHaveBeenCalled();
  expect(reloadModelProviders).not.toHaveBeenCalled();
});

it.each([
  { ownsProviders: false, globalPolicy: false, status: 200 },
  { ownsProviders: true, globalPolicy: false, status: 403 },
  { ownsProviders: false, globalPolicy: true, status: 403 },
])(
  'checks the standalone Desktop save policy (primary providers: $ownsProviders, global policy changes: $globalPolicy)',
  async ({ ownsProviders, globalPolicy, status }) => {
    const { app, persistSettings } = setup();
    const restricted = { security: { auth: { enforcedType: 'openai' } } };
    let accountPolicyChanged = false;
    mocks.loadSettings.mockImplementation((cwd: string) => ({
      merged: cwd === '/primary' || accountPolicyChanged ? restricted : {},
      isTrusted: true,
      workspace: {
        settings:
          cwd === '/primary' && ownsProviders ? { modelProviders: {} } : {},
      },
      user: { settings: {} },
    }));
    mocks.models.mockImplementation(async () => {
      accountPolicyChanged = globalPolicy;
      return { models: ['qwen3.8-max'], cached: false };
    });

    const response = await request(app)
      .post('/auth/subscription/model')
      .send({ settingsScope: 'provider' });

    expect(response.status).toBe(status);
    if (status === 200) {
      expect(persistSettings).toHaveBeenCalledExactlyOnceWith(
        '/primary',
        [
          {
            scope: SettingScope.User,
            key: 'security.auth.selectedType',
            value: 'qwen-subscription',
          },
          { scope: SettingScope.User, key: 'model.name', value: 'qwen3.8-max' },
          {
            scope: SettingScope.User,
            key: 'model.baseUrl',
            value: QWEN_SUBSCRIPTION_BASE_URL,
          },
        ],
        expect.any(Function),
      );
    } else {
      expect(response.body.code).toBe('auth_type_enforced');
      expect(persistSettings).not.toHaveBeenCalled();
    }
  },
);

it('rejects activation when project settings are unavailable', async () => {
  const { app, persistSettings } = setup();
  mocks.loadSettings.mockReturnValue({ workspaceSettingsActive: false });
  const response = await request(app).post(
    '/workspaces/secondary/auth/subscription',
  );

  expect(response.status).toBe(409);
  expect(response.body.code).toBe('workspace_settings_unavailable');
  expect(mocks.userInfo).not.toHaveBeenCalled();
  expect(persistSettings).not.toHaveBeenCalled();
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
    (
      await request(app)
        .post('/workspaces/secondary/auth/subscription')
        .send({ settingsScope: 'user' })
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post('/workspaces/unknown/auth/subscription')
        .send({ settingsScope: 'user' })
    ).status,
  ).not.toBe(200);
  expect(persistSettings).not.toHaveBeenCalled();
  expect(mocks.userInfo).not.toHaveBeenCalled();
});
it('respects enforced authentication policy without DEV', async () => {
  const { app, persistSettings } = setup();
  mocks.loadSettings.mockReturnValue({
    workspaceSettingsActive: true,
    merged: { security: { auth: { enforcedType: 'openai' } } },
  });
  expect(
    (await request(app).post('/workspaces/secondary/auth/subscription')).body
      .code,
  ).toBe('auth_type_enforced');
  expect(persistSettings).not.toHaveBeenCalled();
});
it.each(['guard', 'primaryGuard'] as const)(
  'does not persist after the %s closes during membership lookup',
  async (target) => {
    const ctx = setup();
    const { app, persistSettings } = ctx;
    mocks.userInfo.mockImplementation(async () => {
      ctx[target].close();
      return { member_type: 'pro' };
    });
    expect(
      (
        await request(app)
          .post('/workspaces/secondary/auth/subscription')
          .send({ settingsScope: 'provider' })
      ).status,
    ).toBe(409);
    expect(persistSettings).not.toHaveBeenCalled();
  },
);
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

it.each(['qwen3.8-max', 'removed-model'])(
  'activates the first served model on explicit sign-in instead of the saved model %s',
  async (savedModel) => {
    const { app, persistSettings } = setup();
    mocks.models.mockResolvedValue({
      models: ['qwen3.8-flash', 'qwen3.8-max'],
      cached: false,
    });
    const project = {
      security: { auth: { selectedType: 'qwen-subscription' } },
      model: { name: savedModel },
    };
    mocks.loadSettings.mockReturnValue({
      isTrusted: true,
      workspaceSettingsActive: true,
      merged: project,
      workspace: { settings: project },
      user: { settings: { modelProviders: {} } },
    });
    const response = await request(app).post(
      '/workspaces/secondary/auth/subscription',
    );
    expect(response.status).toBe(200);
    expect(response.body.modelId).toBe('qwen3.8-flash');
    expect(persistSettings).toHaveBeenCalledWith(
      '/secondary',
      expect.arrayContaining([
        {
          scope: SettingScope.Workspace,
          key: 'model.name',
          value: 'qwen3.8-flash',
        },
      ]),
      expect.any(Function),
    );
  },
);
