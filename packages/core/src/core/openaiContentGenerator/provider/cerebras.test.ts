/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'vitest';
import { CerebrasOpenAICompatibleProvider } from './cerebras.js';
import {
  createReasoningRequest,
  expectOutboundRequest,
  expectReasoningReplay,
} from './test-utils/reasoning-wire-contract.js';

const config = {
  apiKey: 'test-api-key',
  baseUrl: 'https://api.cerebras.ai/v1',
  model: 'qwen-3.8-27b',
};
const stripped = {
  role: 'assistant' as const,
  content: 'Hey! How can I help?',
};
const preserved = { ...stripped, reasoning_content: 'The user said test.' };

describe('Cerebras provider outbound compatibility filtering', () => {
  it.each([
    [
      'strips reasoning_content from outgoing requests for api.cerebras.ai without mutating the source history',
      'https://api.cerebras.ai/v1',
      'qwen-3.8-27b',
      stripped,
    ],
    [
      'strips reasoning_content for Cerebras subdomains',
      'https://proxy.api.cerebras.ai/v1',
      'gpt-oss-120b',
      stripped,
    ],
    [
      'does not treat hostile hostnames containing api.cerebras.ai as Cerebras',
      'https://api.cerebras.ai.evil.example/v1',
      'gpt-4o',
      preserved,
    ],
    [
      'preserves reasoning_content for non-Cerebras OpenAI-compatible providers',
      'https://api.openai.com/v1',
      'gpt-4o',
      preserved,
    ],
  ] as const)('%s', (_title, baseUrl, model, expectedAssistant) => {
    expectOutboundRequest(
      { ...config, baseUrl, model },
      createReasoningRequest(config.model),
      expectedAssistant,
    );
  });
});

describe('multi-turn against a Cerebras-like strict endpoint (issue #11045)', () => {
  it('replays reasoning history on follow-up turns without shipping reasoning_content', async () => {
    await expectReasoningReplay(
      CerebrasOpenAICompatibleProvider,
      config,
      'reasoning_content',
      stripped,
    );
  });
});
