/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import {
  LoadedSettings,
  type Settings,
  type SettingsFile,
} from '../../config/settings.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activateSubscription } from './activate-subscription.js';

const mocks = vi.hoisted(() => ({
  userInfo: vi.fn(),
  apply: vi.fn(),
  adapter: {},
  createAdapter: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getUserInfo = mocks.userInfo;
  },
}));
vi.mock('@qwen-code/qwen-code-core/providers/install.js', () => ({
  applyProviderInstallPlan: mocks.apply,
}));
vi.mock('../../config/loadedSettingsAdapter.js', () => ({
  createLoadedSettingsAdapter: mocks.createAdapter,
}));
const settings = {
  merged: {},
  isTrusted: true,
  workspaceSettingsActive: true,
  setValues: vi.fn(),
} as unknown as LoadedSettings;
function config() {
  return {
    refreshSubscriptionModels: vi
      .fn()
      .mockResolvedValue({ models: ['qwen3.8-max'], cached: false }),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    setSubscriptionPlan: vi.fn(),
  } as unknown as Config;
}
beforeEach(() => {
  vi.mocked(settings.setValues).mockClear();
  vi.stubEnv('DEV', false);
  delete process.env['DEV'];
  mocks.userInfo.mockReset().mockResolvedValue({ member_type: 'pro' });
  mocks.apply.mockReset().mockResolvedValue(undefined);
  mocks.createAdapter.mockReset().mockReturnValue(mocks.adapter);
});
afterEach(() => vi.unstubAllEnvs());
it('installs the subscription and switches the current model', async () => {
  const runtime = config();
  const signal = new AbortController().signal;
  await activateSubscription(settings, runtime, signal);
  const [plan, callbacks] = mocks.apply.mock.calls[0];
  expect(plan).toEqual({
    providerId: 'qwen-subscription',
    authType: 'qwen-subscription',
    modelSelection: {
      modelId: 'qwen3.8-max',
      baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
    },
  });
  expect(callbacks.settings).toBe(mocks.adapter);
  expect(settings.setValues).not.toHaveBeenCalled();
  callbacks.syncAuthState(
    plan.authType,
    plan.modelSelection.modelId,
    plan.modelSelection.baseUrl,
  );
  await callbacks.refreshAuth(plan.authType);
  expect(runtime.syncModelSelection).toHaveBeenCalledWith(
    'qwen-subscription',
    'qwen3.8-max',
    'https://api.qwen.ai/compatible-mode/v1',
  );
  expect(runtime.refreshAuth).toHaveBeenCalledWith('qwen-subscription');
  expect(runtime.setSubscriptionPlan).toHaveBeenCalledWith('pro');
});
it.each(['plus', 'pro', 'PLUS', 'Pro', 'pLuS'])(
  'activates %s membership without mapping its name',
  async (member_type) => {
    mocks.userInfo.mockResolvedValue({ member_type });
    const runtime = config();
    await activateSubscription(settings, runtime, new AbortController().signal);
    expect(runtime.setSubscriptionPlan).toHaveBeenCalledWith(
      member_type.toLowerCase(),
    );
  },
);
it.each([
  null,
  ...['free', 'lite', 'FREE', 'LITE', 'future-plan'].map((member_type) => ({
    member_type,
  })),
])('rejects a missing paid membership', async (info) => {
  mocks.userInfo.mockResolvedValue(info);
  await expect(
    activateSubscription(settings, config(), new AbortController().signal),
  ).rejects.toThrow('Plus or Pro');
  expect(mocks.apply).not.toHaveBeenCalled();
});

it('selects the first served model when Max is unavailable', async () => {
  const runtime = config();
  vi.mocked(runtime.refreshSubscriptionModels).mockResolvedValue({
    models: ['future-model', 'other-model'],
    cached: false,
  });
  await activateSubscription(settings, runtime, new AbortController().signal);
  expect(mocks.apply.mock.calls[0][0].modelSelection.modelId).toBe(
    'future-model',
  );
});

it.each(['qwen3.8-flash', 'removed-model'])(
  'selects Max on explicit sign-in instead of the saved model %s',
  async (savedModel) => {
    const runtime = config();
    vi.mocked(runtime.refreshSubscriptionModels).mockResolvedValue({
      models: ['qwen3.8-flash', 'qwen3.8-max'],
      cached: false,
    });
    const existing = {
      ...settings,
      merged: {
        security: { auth: { selectedType: 'qwen-subscription' } },
        model: { name: savedModel },
      },
    } as unknown as LoadedSettings;
    await activateSubscription(existing, runtime, new AbortController().signal);
    expect(mocks.apply.mock.calls[0][0].modelSelection.modelId).toBe(
      'qwen3.8-max',
    );
  },
);
it('honors the authentication policy without DEV', async () => {
  const restricted = {
    ...settings,
    merged: { security: { auth: { enforcedType: 'openai' } } },
  } as LoadedSettings;
  await expect(
    activateSubscription(restricted, config(), new AbortController().signal),
  ).rejects.toThrow('policy');
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.userInfo).not.toHaveBeenCalled();
});
it('does not persist after closing during membership validation', async () => {
  const controller = new AbortController();
  mocks.userInfo.mockImplementation(async () => {
    controller.abort();
    return { member_type: 'pro' };
  });
  await expect(
    activateSubscription(settings, config(), controller.signal),
  ).rejects.toThrow();
  expect(mocks.apply).not.toHaveBeenCalled();
});

it('rejects an untrusted workspace without falling back to user settings', async () => {
  const untrusted = { ...settings, isTrusted: false } as LoadedSettings;
  await expect(
    activateSubscription(untrusted, config(), new AbortController().signal),
  ).rejects.toThrow('not trusted');
  expect(mocks.userInfo).not.toHaveBeenCalled();
  expect(mocks.createAdapter).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

it.each<{ project: Settings; saveToProject: boolean }>([
  { project: {}, saveToProject: false },
  {
    project: {
      model: { name: 'project-api-model' },
      security: { auth: { selectedType: AuthType.USE_OPENAI } },
    },
    saveToProject: false,
  },
  { project: { modelProviders: {} }, saveToProject: true },
  {
    project: {
      security: { auth: { selectedType: AuthType.QWEN_SUBSCRIPTION } },
    },
    saveToProject: true,
  },
])(
  'uses the API Key settings scope for project $project',
  async ({ project, saveToProject }) => {
    const { createLoadedSettingsAdapter } = await vi.importActual<
      typeof import('../../config/loadedSettingsAdapter.js')
    >('../../config/loadedSettingsAdapter.js');
    const { applyProviderInstallPlan } = await vi.importActual<
      typeof import('@qwen-code/qwen-code-core/providers/install.js')
    >('@qwen-code/qwen-code-core/providers/install.js');
    mocks.createAdapter.mockImplementation(createLoadedSettingsAdapter);
    mocks.apply.mockImplementation(applyProviderInstallPlan);
    const directory = mkdtempSync(path.join(tmpdir(), 'subscription-scope-'));
    try {
      const layer = (name: string, data: Settings = {}): SettingsFile => ({
        path: path.join(directory, name, '.qwen', 'settings.json'),
        settings: structuredClone(data),
        originalSettings: structuredClone(data),
      });
      const user = layer('user', {
        modelProviders: {},
        model: { name: 'user-api-model' },
        security: { auth: { selectedType: AuthType.USE_OPENAI } },
        env: { OPENAI_API_KEY: 'fixture-key' },
      });
      const workspace = layer('project', project);
      const other = saveToProject ? user : workspace;
      const otherBefore = JSON.stringify(other.originalSettings);
      for (const file of [user, workspace]) {
        if (Object.keys(file.settings).length > 0) {
          mkdirSync(path.dirname(file.path), { recursive: true });
          writeFileSync(file.path, JSON.stringify(file.settings));
        }
      }
      const loaded = new LoadedSettings(
        layer('system'),
        layer('system-defaults'),
        user,
        workspace,
        true,
        new Set(),
      );
      const runtime = config();
      await activateSubscription(loaded, runtime, new AbortController().signal);
      const target = saveToProject ? workspace : user;
      expect(JSON.parse(readFileSync(target.path, 'utf8'))).toMatchObject({
        security: { auth: { selectedType: 'qwen-subscription' } },
        model: {
          name: 'qwen3.8-max',
          baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
        },
      });
      if (otherBefore !== '{}') {
        expect(readFileSync(other.path, 'utf8')).toBe(otherBefore);
      } else {
        expect(() => readFileSync(other.path, 'utf8')).toThrow(/ENOENT/);
      }
      expect(JSON.parse(readFileSync(user.path, 'utf8'))).toMatchObject({
        env: { OPENAI_API_KEY: 'fixture-key' },
      });
      expect(runtime.setSubscriptionPlan).toHaveBeenCalledWith('pro');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('keeps committed disk settings and runtime consistent when the dialog closes during refresh', async () => {
  const { applyProviderInstallPlan } = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core/providers/install.js')
  >('@qwen-code/qwen-code-core/providers/install.js');
  const directory = mkdtempSync(
    path.join(tmpdir(), 'subscription-activation-cancel-'),
  );
  const file = path.join(directory, 'settings.json');
  const before: Record<string, unknown> = {
    'security.auth.selectedType': 'openai',
    'model.name': 'previous-model',
  };
  let persisted = { ...before };
  const write = () => writeFileSync(file, JSON.stringify(persisted));
  write();
  const restore = vi.fn(() => {
    persisted = { ...before };
    write();
  });
  const adapter = {
    getValue: (key: string) => persisted[key],
    getModelProviders: () => ({}),
    setValue: (key: string, value: unknown) => {
      persisted[key] = value;
      write();
    },
    persist: write,
    restore,
  };
  mocks.createAdapter.mockReturnValue(adapter);
  mocks.apply.mockImplementation(applyProviderInstallPlan);
  const controller = new AbortController();
  const runtime = config();
  let runtimeAuth = 'openai';
  vi.mocked(runtime.syncModelSelection).mockImplementation((authType) => {
    runtimeAuth = authType;
  });
  vi.mocked(runtime.refreshAuth).mockImplementation(async () => {
    controller.abort();
  });
  try {
    await expect(
      activateSubscription(settings, runtime, controller.signal),
    ).resolves.toEqual({ member_type: 'pro' });
    const disk = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(controller.signal.aborted).toBe(true);
    expect(disk['security.auth.selectedType']).toBe('qwen-subscription');
    expect(disk['model.name']).toBe('qwen3.8-max');
    expect(runtimeAuth).toBe(disk['security.auth.selectedType']);
    expect(restore).not.toHaveBeenCalled();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
