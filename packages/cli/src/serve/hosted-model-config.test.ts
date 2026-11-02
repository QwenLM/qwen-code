/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parseHostedModelConfig,
  parseHostedModelConfigDigest,
} from './hosted-model-config.js';
import { HostedModelUnavailableError } from './hosted-agent-definition.js';

const digest = `sha256:${'a'.repeat(64)}`;
const config = {
  protocol: 'openai',
  model: 'session-model',
  base_url: 'https://model.example/v1',
  api_key: 'synthetic-session-key',
  generation_config: { temperature: 0.4, max_tokens: 128, seed: -1 },
};

describe('Hosted Session model configuration', () => {
  it.each(['openai', 'openai-responses', 'anthropic', 'gemini'])(
    'maps %s without interpreting credentials as environment references',
    (protocol) => {
      expect(
        parseHostedModelConfig(
          { digest, config: { ...config, protocol } },
          digest,
        ),
      ).toEqual({
        authType: protocol,
        ...(protocol === 'gemini' ? { vertexai: false } : {}),
        model: config.model,
        baseUrl: config.base_url,
        apiKey: config.api_key,
        samplingParams: config.generation_config,
      });
    },
  );

  it.each([
    { protocol: 'qwen-oauth' },
    { api_key: '' },
    { api_key: 'unsafe\nkey' },
    { base_url: 'https://user:password@model.example/v1' },
    { base_url: 'https://model.example/v1?key=secret' },
    { base_url: 'file:///tmp/model' },
    { model: 'x'.repeat(513) },
    { headers: { authorization: 'secret' } },
    { generation_config: { model: 'override' } },
    { generation_config: { temperature: 3 } },
    { generation_config: { top_p: -1 } },
    { generation_config: { max_tokens: 0.5 } },
    { generation_config: { seed: 2147483648 } },
    { generation_config: null },
  ])('rejects invalid configuration: %j', (overrides) => {
    expect(() =>
      parseHostedModelConfig(
        { digest, config: { ...config, ...overrides } },
        digest,
      ),
    ).toThrow(HostedModelUnavailableError);
  });

  it('fails closed on a different digest or malformed envelope', () => {
    expect(parseHostedModelConfigDigest(undefined)).toBeUndefined();
    expect(parseHostedModelConfigDigest(digest)).toBe(digest);
    for (const value of [null, '', 'a'.repeat(64)]) {
      expect(() => parseHostedModelConfigDigest(value)).toThrow(
        HostedModelUnavailableError,
      );
    }
    expect(() =>
      parseHostedModelConfig({ digest, config }, `sha256:${'b'.repeat(64)}`),
    ).toThrow(HostedModelUnavailableError);
    expect(() =>
      parseHostedModelConfig({ digest, config, extra: true }, digest),
    ).toThrow(HostedModelUnavailableError);
  });
});
