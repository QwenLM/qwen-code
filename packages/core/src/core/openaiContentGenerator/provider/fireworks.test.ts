/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'vitest';
import { FireworksOpenAICompatibleProvider } from './fireworks.js';
import {
  createReasoningRequest,
  expectOutboundRequest,
  expectReasoningReplay,
} from './test-utils/reasoning-wire-contract.js';

const config = {
  apiKey: 'test-api-key',
  baseUrl: 'https://api.fireworks.ai/inference/v1',
  model: 'accounts/fireworks/models/qwen3p8-max',
};
const preserved = {
  role: 'assistant' as const,
  content: 'Hey! How can I help?',
  reasoning_content: 'The user said test.',
};
const mirrored = { ...preserved, reasoning: 'The user said test.' };

describe('Fireworks provider reasoning-mirror suppression (issue #11657)', () => {
  it.each([
    [
      'drops the mirrored reasoning field for api.fireworks.ai while preserving reasoning_content, without mutating the source history',
      'https://api.fireworks.ai/inference/v1',
      'accounts/fireworks/models/qwen3p8-max',
      preserved,
    ],
    [
      'drops the mirrored reasoning field for Fireworks subdomains',
      'https://inference.api.fireworks.ai/v1',
      'accounts/fireworks/models/qwen3p8-max',
      preserved,
    ],
    [
      'does not treat hostile hostnames containing api.fireworks.ai as Fireworks',
      'https://api.fireworks.ai.evil.example/v1',
      'accounts/fireworks/models/qwen3p8-max',
      mirrored,
    ],
    [
      'leaves non-Fireworks qwen3 endpoints mirroring as before',
      'https://api.openai.com/v1',
      'accounts/other-vendor/models/qwen3-something',
      mirrored,
    ],
  ] as const)('%s', (_title, baseUrl, model, expectedAssistant) => {
    expectOutboundRequest(
      { ...config, baseUrl, model },
      createReasoningRequest(config.model),
      expectedAssistant,
    );
  });

  it('keeps an explicit reasoning field that differs from reasoning_content', () => {
    const assistant = { ...preserved, reasoning: 'Canonical reasoning field' };
    expectOutboundRequest(
      config,
      createReasoningRequest(config.model, assistant),
      { ...preserved, reasoning: 'Canonical reasoning field' },
    );
  });
});

describe('tool-call continuation against a Fireworks-like strict endpoint (issue #11657)', () => {
  it('continues a qwen3 tool-call conversation without shipping the mirrored reasoning field', async () => {
    await expectReasoningReplay(
      FireworksOpenAICompatibleProvider,
      config,
      'reasoning',
      preserved,
    );
  });
});
