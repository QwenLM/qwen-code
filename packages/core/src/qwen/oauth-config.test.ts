/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import {
  getQwenOAuthConfig,
  getQwenSubscriptionPlansUrl,
  withQwenChatTracking,
} from './oauth-config.js';

afterEach(() => vi.unstubAllEnvs());

it('opens Code plans on the web home without device authorization parameters', () => {
  const url = new URL(getQwenSubscriptionPlansUrl('cli'));
  expect(url.origin).toBe(getQwenOAuthConfig().webOrigin);
  expect(url.pathname).toBe('/');
  expect([...url.searchParams]).toEqual([
    ['memberPlan', 'qwen_code'],
    ['entry', 'qwen_code'],
    ['paywallScene', 'cli'],
  ]);
  expect(url.hash).toBe('');
});

it('updates the paywall scene on a legacy Qwen link without changing its client', () => {
  const url = withQwenChatTracking(
    'https://chat.qwen.ai/device?code=123&client=original&entry=qwen_code&paywallScene=cli#confirm',
    'plugin',
  );
  expect(url).toBe(
    'https://chat.qwen.ai/device?code=123&client=original&entry=qwen_code&paywallScene=plugin#confirm',
  );
  const other = 'https://chat.qwen.ai.example.test/device?code=123';
  expect(withQwenChatTracking(other, 'plugin')).toBe(other);
});

it('uses the production configuration without environment setup', () => {
  vi.stubEnv('QWEN_OAUTH_BASE_URL', undefined);
  vi.stubEnv('QWEN_OAUTH_CLIENT_ID', undefined);
  vi.stubEnv('QWEN_HOME', undefined);
  expect(getQwenOAuthConfig()).toEqual({
    baseUrl: 'https://auth.qwen.ai',
    clientId: 'qwen-code-cli',
    webOrigin: 'https://chat.qwen.ai',
  });
});

it('does not override configuration with environment variables', () => {
  const config = getQwenOAuthConfig();
  vi.stubEnv('QWEN_OAUTH_BASE_URL', 'https://other.example.test');
  vi.stubEnv('QWEN_OAUTH_CLIENT_ID', 'other-client');
  expect(getQwenOAuthConfig()).toEqual(config);
});
