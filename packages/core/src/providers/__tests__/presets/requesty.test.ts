/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
// Re-import via the relative source path so the new ownsModel envKey gate
// is exercised even before dist/ is rebuilt (the @qwen-code/qwen-code-core
// package resolves to dist/ on a fresh branch).
import { requestyProvider, REQUESTY_ENV_KEY } from '../../presets/requesty.js';

describe('requestyProvider', () => {
  it('owns models that match BOTH our envKey and a router.requesty.ai host', () => {
    expect(
      requestyProvider.ownsModel?.({
        id: 'requesty-model',
        baseUrl: 'https://router.requesty.ai/v1',
        envKey: REQUESTY_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('refuses ownership over a different envKey on the same host (user-added entry)', () => {
    // A user wired their own gateway through router.requesty.ai with a custom
    // env var — re-install must not silently delete their model entry.
    expect(
      requestyProvider.ownsModel?.({
        id: 'user-added',
        baseUrl: 'https://router.requesty.ai/v1',
        envKey: 'MY_PRIVATE_GATEWAY_KEY',
      }),
    ).toBe(false);
  });

  it('refuses ownership over an unrelated host even with our envKey', () => {
    expect(
      requestyProvider.ownsModel?.({
        id: 'other-model',
        baseUrl: 'https://api.example.com/v1',
        envKey: REQUESTY_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('refuses ownership when baseUrl is missing or malformed', () => {
    expect(
      requestyProvider.ownsModel?.({
        id: 'no-url',
        envKey: REQUESTY_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      requestyProvider.ownsModel?.({
        id: 'bad-url',
        baseUrl: 'not a url',
        envKey: REQUESTY_ENV_KEY,
      }),
    ).toBe(false);
  });
});
