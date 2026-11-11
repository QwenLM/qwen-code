/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  makeFakeConfig,
  type Config,
  type Model,
  type ModelProvider,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { createAuthGate } from './authGate.js';

const subscription = vi.hoisted(() => ({
  isSignedIn: vi.fn(() => true),
  getAccessToken: vi.fn(async () => 'subscription-token'),
}));
const createSubscription = vi.hoisted(() => vi.fn(() => subscription));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, QwenSubscriptionSession: createSubscription };
});

const subscriptionSettings = (): ReturnType<typeof createMockSettings> =>
  createMockSettings({
    merged: { security: { auth: { selectedType: 'qwen-subscription' } } },
  });

function configWithModels(count: number): Config {
  const models = Array.from({ length: count }, (_, index) => ({
    key: `test/model-${index}`,
    source: 'test',
    displayName: `Model ${index}`,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: { supported: false, supportedEfforts: [] },
      contextWindows: [{ tokens: 128_000 }],
    },
    limits: { maxContextTokens: 128_000, maxOutputTokens: 8192 },
  })) as Model[];
  const provider = {
    providerId: 'test',
    start: async () => {},
    stop: async () => {},
    listModels: async () => models,
    getModel: async (key: string) =>
      models.find((model) => model.key === key),
  } as unknown as ModelProvider;
  return makeFakeConfig({ modelProviderFactory: () => [provider] });
}

describe('AuthGate', () => {
  it('shows the connect-provider flow when no model source exists', async () => {
    const onStateChange = vi.fn();
    const config = makeFakeConfig({ modelProviderFactory: () => [] });
    const Gate = createAuthGate();
    const { lastFrame, unmount } = await renderWithProviders(
      <Gate onStateChange={onStateChange} />,
      { config },
    );

    try {
      await vi.waitFor(() =>
        expect(lastFrame()).toContain('Connect a Provider'),
      );
      expect(onStateChange).toHaveBeenCalledWith({
        status: 'awaiting',
        visible: true,
      });
    } finally {
      unmount();
    }
  });

  it('asks for sign-in when the selected subscription session is unusable', async () => {
    subscription.isSignedIn.mockReturnValue(true);
    subscription.getAccessToken.mockRejectedValueOnce(
      new Error('invalid_grant'),
    );
    const onStateChange = vi.fn();
    const Gate = createAuthGate();
    const { lastFrame, unmount } = await renderWithProviders(
      <Gate onStateChange={onStateChange} />,
      { config: configWithModels(1), settings: subscriptionSettings() },
    );

    try {
      await vi.waitFor(() =>
        expect(lastFrame()).toContain('Connect a Provider'),
      );
      expect(onStateChange).toHaveBeenCalledWith({
        status: 'awaiting',
        visible: true,
      });
    } finally {
      unmount();
    }
  });

  it('stays ready when the subscription session can be refreshed', async () => {
    subscription.isSignedIn.mockReturnValue(true);
    subscription.getAccessToken.mockResolvedValue('fresh-token');
    const onStateChange = vi.fn();
    const Gate = createAuthGate();
    const { unmount } = await renderWithProviders(
      <Gate onStateChange={onStateChange} />,
      { config: configWithModels(1), settings: subscriptionSettings() },
    );

    try {
      await vi.waitFor(() =>
        expect(onStateChange).toHaveBeenCalledWith({
          status: 'ready',
          visible: false,
        }),
      );
    } finally {
      unmount();
    }
  });
});
