/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelConfig, ModelProvidersConfig } from '../models/types.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import { getModelsForProviderProtocol } from './provider-config.js';
import { preserveModelProviderPlaceholders } from './model-config-serialization.js';

const first = {
  id: 'same',
  baseUrl: '${FIRST_URL}',
  envKey: 'FIRST_KEY',
  generationConfig: { customHeaders: { 'X-Key': '${FIRST_KEY}' } },
};
const second = {
  ...first,
  baseUrl: '${SECOND_URL}',
  envKey: 'SECOND_KEY',
  generationConfig: { customHeaders: { 'X-Key': '${SECOND_KEY}' } },
};
const env = {
  FIRST_URL: 'https://gateway.example/v1',
  SECOND_URL: 'https://gateway.example/v1',
  FIRST_KEY: 'test-only-first',
  SECOND_KEY: 'test-only-second',
};

function serialize(raw: ModelProvidersConfig) {
  const mapping = { first: 'openai', second: 'openai' };
  const resolved = resolveEnvVarsInObject(raw, env);
  const models = getModelsForProviderProtocol(
    resolved,
    AuthType.USE_OPENAI,
    mapping,
  );
  return preserveModelProviderPlaceholders(
    models.slice(0, 1),
    AuthType.USE_OPENAI,
    resolved,
    raw,
    mapping,
  );
}

describe('preserveModelProviderPlaceholders', () => {
  it.each([true, false])(
    'preserves the first bucket winner across duplicate identities (first=%s)',
    (firstWins) => {
      const raw = firstWins
        ? { first: [first], second: [second] }
        : { second: [second], first: [first] };
      expect(serialize(raw)).toEqual([
        { ...(firstWins ? first : second), wireApi: 'chat-completions' },
      ]);
      expect(raw.first).toEqual([first]);
      expect(raw.second).toEqual([second]);
    },
  );

  it('skips an invalid entry when choosing the first source bucket', () => {
    expect(
      serialize({
        first: [{ ...first, wireApi: 'invalid' as ModelConfig['wireApi'] }],
        second: [second],
      }),
    ).toEqual([{ ...second, wireApi: 'chat-completions' }]);
  });

  it('still rejects ambiguous placeholders inside the winning bucket', () => {
    expect(() =>
      serialize({ first: [first, second], second: [second] }),
    ).toThrow(
      'Cannot preserve placeholders in an ambiguous model configuration',
    );
  });

  it('does not let ambiguity in a shadowed bucket override the first winner', () => {
    expect(serialize({ first: [first], second: [first, second] })).toEqual([
      { ...first, wireApi: 'chat-completions' },
    ]);
  });
});
