/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  deepinfraProvider,
  DEEPINFRA_ENV_KEY,
} from '../../presets/deepinfra.js';

describe('deepinfraProvider', () => {
  it('owns models that match BOTH our envKey and an api.deepinfra.com host', () => {
    expect(
      deepinfraProvider.ownsModel?.({
        id: 'deepinfra-model',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        envKey: DEEPINFRA_ENV_KEY,
      }),
    ).toBe(true);
  });

  it('refuses ownership over a different envKey on the same host (user-added entry)', () => {
    expect(
      deepinfraProvider.ownsModel?.({
        id: 'user-added',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        envKey: 'MY_PRIVATE_GATEWAY_KEY',
      }),
    ).toBe(false);
  });

  it('refuses ownership over an unrelated host even with our envKey', () => {
    expect(
      deepinfraProvider.ownsModel?.({
        id: 'other-model',
        baseUrl: 'https://api.example.com/v1',
        envKey: DEEPINFRA_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('refuses ownership when baseUrl is missing or malformed', () => {
    expect(
      deepinfraProvider.ownsModel?.({
        id: 'no-url',
        envKey: DEEPINFRA_ENV_KEY,
      }),
    ).toBe(false);
    expect(
      deepinfraProvider.ownsModel?.({
        id: 'bad-url',
        baseUrl: 'not a url',
        envKey: DEEPINFRA_ENV_KEY,
      }),
    ).toBe(false);
  });

  it('declares customHeaders for attribution', () => {
    expect(deepinfraProvider.customHeaders).toEqual({
      'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
      'X-Title': 'Qwen Code',
    });
  });

  it('declares active non-deprecated models with verified context lengths', () => {
    expect(deepinfraProvider.models).toEqual([
      { id: 'deepseek-ai/DeepSeek-V3', contextWindowSize: 163840 },
      { id: 'deepseek-ai/DeepSeek-R1-0528', contextWindowSize: 163840 },
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        contextWindowSize: 131072,
      },
      { id: 'Qwen/Qwen2.5-72B-Instruct', contextWindowSize: 32768 },
    ]);
  });
});
