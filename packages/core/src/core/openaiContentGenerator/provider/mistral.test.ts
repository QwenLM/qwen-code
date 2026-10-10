/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, vi } from 'vitest';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import {
  createCliConfig,
  createReasoningRequest,
  expectOutboundRequest,
} from './test-utils/reasoning-wire-contract.js';

const config = {
  apiKey: 'test-api-key',
  baseUrl: 'https://api.mistral.ai/v1',
  model: 'mistral-large-latest',
};
const stripped = { role: 'assistant' as const, content: 'OK' };
const preserved = {
  ...stripped,
  reasoning_content: 'User asked for a short response.',
};
const createRequest = () =>
  createReasoningRequest(config.model, preserved, 'Say OK', 'Say OK again');

describe('Mistral provider outbound compatibility filtering', () => {
  it.each([
    [
      'strips reasoning_content from outgoing requests for api.mistral.ai without mutating the source history',
      'https://api.mistral.ai/v1',
      'strict-chat-alias',
      stripped,
    ],
    [
      'also strips reasoning_content when a Mistral model is served behind a custom base URL',
      'https://strict-proxy.example.com/v1',
      'Mistral-Large-Latest',
      stripped,
    ],
    [
      'preserves reasoning_content for non-Mistral OpenAI-compatible providers',
      'https://api.openai.com/v1',
      'gpt-4o',
      preserved,
    ],
    [
      'does not treat hostile hostnames containing api.mistral.ai as Mistral',
      'https://api.mistral.ai.evil.example/v1',
      'gpt-4o',
      preserved,
    ],
  ] as const)('%s', (_title, baseUrl, model, expectedAssistant) => {
    expectOutboundRequest(
      { ...config, baseUrl, model },
      createRequest(),
      expectedAssistant,
    );
  });

  it('preserves declared DeepSeek history on a Mistral-named gateway alias', () => {
    const cliConfig = createCliConfig();
    cliConfig.getResolvedModelConfig = vi.fn().mockReturnValue({
      capabilities: {
        reasoning: {
          profile: 'deepseek-openai',
          efforts: ['high', 'max'],
          defaultEffort: 'high',
        },
      },
    });
    expectOutboundRequest(
      {
        ...config,
        baseUrl: 'https://gateway.example/v1',
        authType: 'openai' as ContentGeneratorConfig['authType'],
      },
      createRequest(),
      preserved,
      cliConfig,
      'prompt',
    );
  });
});
