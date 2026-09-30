/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

function createCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

function createProviderConfig(
  overrides: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  return {
    apiKey: 'xai-test-key',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.5',
    ...overrides,
  } as ContentGeneratorConfig;
}

describe('Grok provider selection', () => {
  // xAI's API is standard OpenAI-compatible, so Grok intentionally has no
  // bespoke handler. These tests guard against a future name/host matcher
  // accidentally capturing Grok and mutating its otherwise-standard requests.
  it('resolves the xAI endpoint to the default OpenAI-compatible provider', () => {
    const provider = determineProvider(
      createProviderConfig({}),
      createCliConfig(),
    );
    expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
  });

  it.each([
    'grok-4.5',
    'grok-4.3',
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-multi-agent-0309',
    'grok-build-0.1',
  ])('uses the default provider for %s', (model) => {
    const provider = determineProvider(
      createProviderConfig({ model }),
      createCliConfig(),
    );
    expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
  });

  it('leaves outgoing requests unchanged (no provider-specific rewriting)', () => {
    const provider = determineProvider(
      createProviderConfig({}),
      createCliConfig(),
    );
    const request = {
      model: 'grok-4.5',
      messages: [{ role: 'user' as const, content: 'Say OK' }],
      max_tokens: 100,
    };
    const result = provider.buildRequest(request, 'prompt-123');
    expect(result).toEqual(request);
  });
});
