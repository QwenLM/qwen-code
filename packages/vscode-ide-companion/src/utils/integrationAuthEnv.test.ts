/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

/* eslint-disable import/no-internal-modules -- shared test-runner auth helper lives under /test */
import {
  buildIntegrationRunnerEnv,
  hasIntegrationAuthEnv,
  resolveIntegrationAuthEnv,
} from '../../test/integrationAuthEnv.mjs';
/* eslint-enable import/no-internal-modules */

describe('integrationAuthEnv', () => {
  it('accepts OPENAI_* credentials for VS Code integration tests', () => {
    expect(
      hasIntegrationAuthEnv({
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://example.com/v1',
        OPENAI_MODEL: 'gpt-test',
      }),
    ).toBe(true);

    expect(
      resolveIntegrationAuthEnv({
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://example.com/v1',
        OPENAI_MODEL: 'gpt-test',
      }),
    ).toEqual({
      hasQwenOauth: false,
      hasModelAuth: true,
      openAiApiKey: 'openai-key',
      openAiBaseUrl: 'https://example.com/v1',
      openAiModel: 'gpt-test',
      qwenOauth: undefined,
    });
  });

  it('prefers QWEN_TEST_* overrides when both env shapes exist', () => {
    expect(
      resolveIntegrationAuthEnv({
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://openai.example/v1',
        OPENAI_MODEL: 'openai-model',
        QWEN_TEST_API_KEY: 'qwen-test-key',
        QWEN_TEST_BASE_URL: 'https://qwen-test.example/v1',
        QWEN_TEST_MODEL: 'qwen-test-model',
      }),
    ).toEqual({
      hasQwenOauth: false,
      hasModelAuth: true,
      openAiApiKey: 'qwen-test-key',
      openAiBaseUrl: 'https://qwen-test.example/v1',
      openAiModel: 'qwen-test-model',
      qwenOauth: undefined,
    });
  });

  it('accepts QWEN_OAUTH without API key envs', () => {
    expect(
      hasIntegrationAuthEnv({
        QWEN_OAUTH: '1',
      }),
    ).toBe(true);

    expect(
      resolveIntegrationAuthEnv({
        QWEN_OAUTH: '1',
      }),
    ).toEqual({
      hasQwenOauth: true,
      hasModelAuth: false,
      openAiApiKey: undefined,
      openAiBaseUrl: undefined,
      openAiModel: undefined,
      qwenOauth: '1',
    });
  });

  it('rejects partial OPENAI_* credentials', () => {
    expect(
      hasIntegrationAuthEnv({
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://example.com/v1',
      }),
    ).toBe(false);
  });

  it('builds runner env with QWEN_TEST_* overrides and QWEN_OAUTH', () => {
    expect(
      buildIntegrationRunnerEnv({
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://openai.example/v1',
        OPENAI_MODEL: 'openai-model',
        QWEN_TEST_API_KEY: 'qwen-test-key',
        QWEN_TEST_BASE_URL: 'https://qwen-test.example/v1',
        QWEN_TEST_MODEL: 'qwen-test-model',
        QWEN_OAUTH: 'oauth-token',
      }),
    ).toEqual({
      OPENAI_API_KEY: 'qwen-test-key',
      OPENAI_BASE_URL: 'https://qwen-test.example/v1',
      OPENAI_MODEL: 'qwen-test-model',
      QWEN_OAUTH: 'oauth-token',
    });
  });
});
