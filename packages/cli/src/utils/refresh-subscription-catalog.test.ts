/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { refreshSubscriptionCatalog } from './refresh-subscription-catalog.js';
import {
  SUBSCRIPTION_MODELS_CACHED,
  SUBSCRIPTION_MODELS_UNAVAILABLE,
} from '@qwen-code/qwen-code-core/qwen/subscription-models.js';

const account = vi.hoisted(() => ({ signedIn: true }));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    isSignedIn = () => account.signedIn;
  },
}));

const chat = vi.fn();
const scenes = vi.fn();
const config = {
  refreshSubscriptionModels: chat,
  refreshSubscriptionScenes: scenes,
} as unknown as Config;
beforeEach(() => {
  vi.resetAllMocks();
  account.signedIn = true;
  chat.mockResolvedValue({ cached: false });
  scenes.mockResolvedValue({ cached: false });
});

it('refreshes on every selection without a session TTL', async () => {
  await refreshSubscriptionCatalog(config, false);
  await refreshSubscriptionCatalog(config, false);
  await refreshSubscriptionCatalog(config, true);
  await refreshSubscriptionCatalog(config, true);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(scenes).toHaveBeenCalledTimes(2);
});
it('does not request account catalogs for API-key-only users', async () => {
  account.signedIn = false;
  await refreshSubscriptionCatalog(config, true);
  expect(scenes).not.toHaveBeenCalled();
});
it('reports cached fallback and discovery failure without hiding local providers', async () => {
  scenes
    .mockResolvedValueOnce({ cached: true })
    .mockRejectedValueOnce(new Error('offline'));
  expect(await refreshSubscriptionCatalog(config, true)).toBe(
    SUBSCRIPTION_MODELS_CACHED,
  );
  expect(await refreshSubscriptionCatalog(config, true)).toBe(
    SUBSCRIPTION_MODELS_UNAVAILABLE,
  );
});
