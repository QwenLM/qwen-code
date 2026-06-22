/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
// Re-import via the relative source path so the new ownsModel envKey gate
// is exercised even before dist/ is rebuilt (the @qwen-code/qwen-code-core
// package resolves to dist/ on a fresh branch).
import {
  pleumRouterProvider,
  PLEUMROUTER_ENV_KEY,
} from '../../presets/pleumrouter.js';

describe('pleumRouterProvider', () => {
  it('owns models that match BOTH our envKey and a router.pleum.ai host', () => {
    expect(
      pleumRouterProvider.ownsModel?.({
        id: 'gpt-5.5',
        baseUrl: 'https://router.pleum.ai/v1',
        envKey: PLEUMROUTER_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('refuses ownership over a different envKey on the same host (user-added entry)', () => {
    expect(
      pleumRouterProvider.ownsModel?.({
        id: 'user-added',
        baseUrl: 'https://router.pleum.ai/v1',
        envKey: 'MY_PRIVATE_GATEWAY_KEY',
      }),
    ).toBe(false);
  });

  it('refuses ownership over an unrelated host even with our envKey', () => {
    expect(
      pleumRouterProvider.ownsModel?.({
        id: 'other-model',
        baseUrl: 'https://api.example.com/v1',
        envKey: PLEUMROUTER_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('refuses ownership when baseUrl is missing or malformed', () => {
    expect(
      pleumRouterProvider.ownsModel?.({
        id: 'no-url',
        envKey: PLEUMROUTER_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      pleumRouterProvider.ownsModel?.({
        id: 'bad-url',
        baseUrl: 'not a url',
        envKey: PLEUMROUTER_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('declares customHeaders for attribution', () => {
    expect(pleumRouterProvider.customHeaders).toEqual({
      'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
      'X-Title': 'Qwen Code',
    });
  });
});
