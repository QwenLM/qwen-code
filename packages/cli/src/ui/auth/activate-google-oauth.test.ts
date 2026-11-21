/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { activateGoogleOAuth } from './activate-google-oauth.js';

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  account: vi.fn(),
  apply: vi.fn(),
  adapter: vi.fn(() => ({})),
}));
vi.mock('@qwen-code/qwen-code-core/code_assist/index.js', () => ({
  setupGoogleOAuthForUser: mocks.setup,
  readGoogleAccount: mocks.account,
}));
vi.mock('@qwen-code/qwen-code-core/providers/install.js', () => ({
  applyProviderInstallPlan: mocks.apply,
}));
vi.mock('../../config/loadedSettingsAdapter.js', () => ({
  createLoadedSettingsAdapter: mocks.adapter,
}));

function runtime(): Config {
  return {
    getCurrentAuthType: () => undefined,
    getAuthType: () => undefined,
    getModel: () => '',
    getContentGeneratorConfig: () => ({}),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
  } as unknown as Config;
}

function settings(
  overrides: { trusted?: boolean; enforcedType?: AuthType } = {},
): LoadedSettings {
  return {
    isTrusted: overrides.trusted ?? true,
    merged: {
      security: {
        auth: {
          ...(overrides.enforcedType
            ? { enforcedType: overrides.enforcedType }
            : {}),
        },
      },
    },
  } as LoadedSettings;
}

describe('activateGoogleOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setup.mockResolvedValue({
      projectId: 'project-1',
      userTier: 'free-tier',
      userTierName: 'Free',
    });
    mocks.account.mockResolvedValue('account@example.test');
    mocks.apply.mockResolvedValue(undefined);
  });

  it('commits the provider only after OAuth and Code Assist setup', async () => {
    const config = runtime();
    const signal = new AbortController().signal;
    const callbacks = { onAuthorizationUrl: vi.fn() };
    const info = await activateGoogleOAuth(
      settings(),
      config,
      signal,
      callbacks,
    );

    expect(info).toMatchObject({
      projectId: 'project-1',
      userTier: 'free-tier',
      email: 'account@example.test',
    });
    expect(mocks.setup).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ ...callbacks, signal }),
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'google-oauth',
        authType: AuthType.GOOGLE_OAUTH,
        modelSelection: expect.objectContaining({
          modelId: 'gemini-4-argon',
        }),
      }),
      expect.any(Object),
    );
    expect(mocks.setup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.apply.mock.invocationCallOrder[0],
    );
  });

  it('does not alter the provider when setup fails', async () => {
    const error = new Error('onboarding failed');
    mocks.setup.mockRejectedValueOnce(error);
    await expect(
      activateGoogleOAuth(settings(), runtime(), new AbortController().signal),
    ).rejects.toBe(error);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it('rejects policy overrides before starting OAuth', async () => {
    await expect(
      activateGoogleOAuth(
        settings({ enforcedType: AuthType.USE_GEMINI }),
        runtime(),
        new AbortController().signal,
      ),
    ).rejects.toThrow('Authentication is restricted by policy.');
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
