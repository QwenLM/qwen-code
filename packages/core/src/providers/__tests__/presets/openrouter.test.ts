/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
// Re-import via the relative source path so the new ownsModel envKey gate
// is exercised even before dist/ is rebuilt (the @qwen-code/qwen-code-core
// package resolves to dist/ on a fresh branch).
import {
  openRouterProvider,
  OPENROUTER_ENV_KEY,
} from '../../presets/openrouter.js';

describe('openRouterProvider', () => {
  it('owns models that match BOTH our envKey and an openrouter.ai host', () => {
    expect(
      openRouterProvider.ownsModel?.({
        id: 'openrouter-model',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: OPENROUTER_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('refuses ownership over a different envKey on the same host (user-added entry)', () => {
    // A user wired their own gateway through openrouter.ai with a custom env
    // var — re-install must not silently delete their model entry.
    expect(
      openRouterProvider.ownsModel?.({
        id: 'user-added',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'MY_PRIVATE_GATEWAY_KEY',
      }),
    ).toBe(false);
  });

  it('refuses ownership over an unrelated host even with our envKey', () => {
    expect(
      openRouterProvider.ownsModel?.({
        id: 'other-model',
        baseUrl: 'https://api.example.com/v1',
        envKey: OPENROUTER_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('refuses ownership when baseUrl is missing or malformed', () => {
    expect(
      openRouterProvider.ownsModel?.({
        id: 'no-url',
        envKey: OPENROUTER_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      openRouterProvider.ownsModel?.({
        id: 'bad-url',
        baseUrl: 'not a url',
        envKey: OPENROUTER_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('declares customHeaders for attribution', () => {
    expect(openRouterProvider.customHeaders).toEqual({
      'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
      'X-OpenRouter-Title': 'Qwen Code',
    });
  });
});
