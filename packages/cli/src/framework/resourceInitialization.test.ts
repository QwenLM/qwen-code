/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/resource';
import type { SettingsService } from '@qwen-code/resource';
import {
  AuthType as CoreAuthType,
  QODER_ENV_ACCOUNT_REGION,
  setDefaultAuthType,
  type ModelTransportManager,
} from '@qwen-code/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPublicProviders } from './resourceInitialization.js';
import {
  createQoderProviders,
  isQoderAccountConfigured,
} from '../auth/qoderProviders.js';
import { createQwenSubscriptionProviders } from '../auth/subscriptionProviders.js';

vi.mock('../auth/qoderProviders.js', () => ({
  createQoderProviders: vi.fn(() => [{ providerId: 'qoder' }]),
  isQoderAccountConfigured: vi.fn(() => false),
  resolveConfiguredQoderRegion: vi.fn(() => 'global'),
}));

vi.mock('../auth/subscriptionProviders.js', () => ({
  createQwenSubscriptionProviders: vi.fn(() => []),
}));

const settings = {
  peekUserSettingsSource: () => ({ read: () => undefined }),
} as unknown as SettingsService;
const transports = {} as ModelTransportManager;

describe('createPublicProviders', () => {
  beforeEach(() => {
    vi.mocked(createQoderProviders).mockClear();
    vi.mocked(createQwenSubscriptionProviders).mockClear();
    vi.mocked(createQwenSubscriptionProviders).mockReturnValue([]);
    vi.mocked(isQoderAccountConfigured).mockReset().mockReturnValue(false);
    setDefaultAuthType(CoreAuthType.QODER_BROWSER);
  });

  afterEach(() => {
    setDefaultAuthType(CoreAuthType.QODER_BROWSER);
  });

  it('adds the Qoder OAuth provider only for qoder-oauth', () => {
    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.QODER_OAUTH,
    );

    expect(createQoderProviders).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toContain('qoder');
  });

  it('does not construct the Qoder OAuth provider for other Qoder auth types', () => {
    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.QODER_BROWSER,
    );

    expect(createQoderProviders).not.toHaveBeenCalled();
    expect(providers.map((provider) => provider.providerId)).not.toContain(
      'qoder',
    );
  });

  it('follows the product default when no type is selected', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);

    const providers = createPublicProviders(settings, transports);

    expect(createQoderProviders).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toContain('qoder');
  });

  it('adds the Qwen subscription provider when the account is signed in', () => {
    vi.mocked(createQwenSubscriptionProviders).mockReturnValue([
      { providerId: 'qwen-subscription' } as never,
    ]);

    const providers = createPublicProviders(settings, transports);

    expect(createQwenSubscriptionProviders).toHaveBeenCalledWith(
      settings,
      transports,
    );
    expect(providers.map((provider) => provider.providerId)).toContain(
      'qwen-subscription',
    );
  });

  it('keeps the built-in default when no type is selected', () => {
    createPublicProviders(settings, transports);

    expect(createQoderProviders).not.toHaveBeenCalled();
  });

  it('adds the Qoder provider for an existing account under another auth type', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);
    vi.mocked(isQoderAccountConfigured).mockReturnValue(true);

    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.USE_OPENAI,
    );

    expect(createQoderProviders).toHaveBeenCalledTimes(1);
    expect(providers.map((provider) => provider.providerId)).toContain('qoder');
  });

  it('passes the saved qoder region to provider composition', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);

    createPublicProviders(settings, transports, undefined, 'cn');

    expect(createQoderProviders).toHaveBeenCalledWith(
      settings,
      transports,
      'cn',
    );
  });

  it('lets QWEN_QODER_REGION override the saved region', () => {
    setDefaultAuthType(CoreAuthType.QODER_OAUTH);
    vi.stubEnv(QODER_ENV_ACCOUNT_REGION, 'global');

    try {
      createPublicProviders(settings, transports, undefined, 'cn');

      expect(createQoderProviders).toHaveBeenCalledWith(
        settings,
        transports,
        'global',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores existing accounts when the default is not qoder-oauth', () => {
    vi.mocked(isQoderAccountConfigured).mockReturnValue(true);

    const providers = createPublicProviders(
      settings,
      transports,
      AuthType.USE_OPENAI,
    );

    expect(createQoderProviders).not.toHaveBeenCalled();
    expect(providers.map((provider) => provider.providerId)).not.toContain(
      'qoder',
    );
  });
});
