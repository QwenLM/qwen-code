/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const settings = { merged: {}, isTrusted: true } as LoadedSettings;
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
  vi.stubEnv('DEV', true);
  process.env['DEV'] = 'true';
  mocks.userInfo.mockReset().mockResolvedValue({ member_type: 'pro' });
  mocks.apply.mockReset().mockResolvedValue(undefined);
  mocks.createAdapter.mockReset().mockReturnValue(mocks.adapter);
});
afterEach(() => vi.unstubAllEnvs());
it('uses a token-free install plan and the common selection and refresh callbacks', async () => {
  const runtime = config();
  const signal = new AbortController().signal;
  await activateSubscription(settings, runtime, signal);
  const [plan, callbacks] = mocks.apply.mock.calls[0];
  expect(plan).toEqual({
    providerId: 'qwen-subscription',
    authType: 'qwen-subscription',
    modelSelection: {
      modelId: 'qwen3.8-max',
      baseUrl: 'https://pre-api.qwen.ai/compatible-mode/v1',
    },
  });
  expect(callbacks.settings).toBe(mocks.adapter);
  expect(mocks.createAdapter).toHaveBeenCalledWith(
    settings,
    SettingScope.Workspace,
  );
  callbacks.syncAuthState(
    plan.authType,
    plan.modelSelection.modelId,
    plan.modelSelection.baseUrl,
  );
  await callbacks.refreshAuth(plan.authType);
  expect(runtime.syncModelSelection).toHaveBeenCalledWith(
    'qwen-subscription',
    'qwen3.8-max',
    'https://pre-api.qwen.ai/compatible-mode/v1',
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

it('selects a server model without a fixed allowlist and preserves an existing choice', async () => {
  const runtime = config();
  vi.mocked(runtime.refreshSubscriptionModels).mockResolvedValue({
    models: ['future-model', 'other-model'],
    cached: false,
  });
  await activateSubscription(settings, runtime, new AbortController().signal);
  expect(mocks.apply.mock.calls[0][0].modelSelection.modelId).toBe(
    'future-model',
  );
  const existing = {
    ...settings,
    merged: {
      security: { auth: { selectedType: 'qwen-subscription' } },
      model: { name: 'other-model' },
    },
  } as LoadedSettings;
  await activateSubscription(existing, runtime, new AbortController().signal);
  expect(mocks.apply.mock.calls[1][0].modelSelection.modelId).toBe(
    'other-model',
  );
  existing.merged.model!.name = 'removed-model';
  await expect(
    activateSubscription(existing, runtime, new AbortController().signal),
  ).rejects.toThrow('Run /model');
  expect(mocks.apply).toHaveBeenCalledTimes(2);
});
it('honors the development and authentication policy gates', async () => {
  vi.stubEnv('DEV', false);
  process.env['DEV'] = 'false';
  await expect(
    activateSubscription(settings, config(), new AbortController().signal),
  ).rejects.toThrow('unavailable');
  vi.stubEnv('DEV', true);
  process.env['DEV'] = 'true';
  const restricted = {
    isTrusted: true,
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
