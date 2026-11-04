/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import {
  getQwenOAuthConfig,
  getQwenSubscriptionPlansUrl,
} from './oauth-config.js';

afterEach(() => vi.unstubAllEnvs());

it('opens Code plans on the web home without device authorization parameters', () => {
  const url = new URL(getQwenSubscriptionPlansUrl());
  expect(url.origin).toBe(getQwenOAuthConfig().webOrigin);
  expect(url.pathname).toBe('/');
  expect([...url.searchParams]).toEqual([['memberPlan', 'qwen_code']]);
  expect(url.hash).toBe('');
});

it('uses the preproduction configuration without environment setup', () => {
  vi.stubEnv('QWEN_OAUTH_BASE_URL', undefined);
  vi.stubEnv('QWEN_OAUTH_CLIENT_ID', undefined);
  vi.stubEnv('QWEN_HOME', undefined);
  expect(getQwenOAuthConfig()).toEqual({
    baseUrl: 'https://pre-auth.qwen.ai',
    clientId: 'qwen-code-cli',
    webOrigin: 'https://pre4-chat.qwen.ai',
  });
});

it('does not override configuration with environment variables', () => {
  const config = getQwenOAuthConfig();
  vi.stubEnv('QWEN_OAUTH_BASE_URL', 'https://other.example.test');
  vi.stubEnv('QWEN_OAUTH_CLIENT_ID', 'other-client');
  expect(getQwenOAuthConfig()).toEqual(config);
});
