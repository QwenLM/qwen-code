/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import {
  formatAcpModelId,
  isInlineModelOverrideAllowed,
  parseAcpBaseModelId,
  parseAcpModelOption,
  sanitizeProviderBaseUrl,
} from './acpModelUtils.js';

describe('acpModelUtils', () => {
  it('formats modelId(authType)', () => {
    expect(formatAcpModelId('qwen3', AuthType.QWEN_OAUTH)).toBe(
      `qwen3(${AuthType.QWEN_OAUTH})`,
    );
  });

  it('extracts base model id when string ends with parentheses', () => {
    expect(parseAcpBaseModelId(`qwen3(${AuthType.USE_OPENAI})`)).toBe('qwen3');
  });

  it('does not strip when parentheses are not a trailing suffix', () => {
    expect(parseAcpBaseModelId('qwen3(x) y')).toBe('qwen3(x) y');
  });

  it('parses modelId and validates authType', () => {
    expect(parseAcpModelOption(` qwen3(${AuthType.USE_OPENAI}) `)).toEqual({
      modelId: 'qwen3',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('returns trimmed input as modelId when authType is invalid', () => {
    expect(parseAcpModelOption('qwen3(not-a-real-auth)')).toEqual({
      modelId: 'qwen3(not-a-real-auth)',
    });
  });

  it.each([
    ['not-a-url', 'not-a-url'],
    ['https://api.example/v1', 'https://api.example/v1'],
    ['https://api.example/v1/@scope', 'https://api.example/v1/@scope'],
    ['https://host:99999/path@domain', 'https://host:99999/path@domain'],
    ['https://user@api.example/v1', 'https://api.example/v1'],
    ['https://user@host:99999', 'https://host:99999'],
    ['https://user:secret@api.example/v1', 'https://api.example/v1'],
    [
      'https://user:secret@api.example/v1/@scope',
      'https://api.example/v1/@scope',
    ],
    ['https://user:p ass@api.example/v1', 'https://api.example/v1'],
    [`https://user:p'ass@api.example/v1`, 'https://api.example/v1'],
    ['https://user:p%2Fx@api.example/v1', 'https://api.example/v1'],
    ['https://user:p/x@api.example/v1', 'https://api.example/v1'],
    ['https://user:p?x@api.example/v1', 'https://api.example/v1'],
    ['https://user:p#x@api.example/v1', 'https://api.example/v1'],
    ['https://user:secret@api.example', 'https://api.example'],
  ])('sanitizes provider base URL credentials for %s', (input, expected) => {
    expect(sanitizeProviderBaseUrl(input)).toBe(expected);
  });

  describe('isInlineModelOverrideAllowed', () => {
    const makeConfig = (
      contentGeneratorConfig: unknown,
      available: unknown[],
    ): Config =>
      ({
        getContentGeneratorConfig: () => contentGeneratorConfig,
        getAvailableModelsForAuthType: () => available,
      }) as unknown as Config;

    it('allows a model that matches the active provider identity', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://provider-a.example/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-a.example/v1',
            envKey: 'PROVIDER_A_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(true);
    });

    it('allows a model when both sides have no baseUrl/envKey (e.g. qwen-oauth)', () => {
      const config = makeConfig({ authType: AuthType.QWEN_OAUTH }, [
        { id: 'qwen-max', authType: AuthType.QWEN_OAUTH },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'qwen-max')).toBe(true);
    });

    it('rejects a same-id model with a different baseUrl', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://provider-a.example/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-b.example/v1',
            envKey: 'PROVIDER_A_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(false);
    });

    it('rejects a same-id model with a different credential env key', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://provider-a.example/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-a.example/v1',
            envKey: 'PROVIDER_B_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(false);
    });

    it('rejects an unknown model id', () => {
      const config = makeConfig({ authType: AuthType.QWEN_OAUTH }, [
        { id: 'qwen-max', authType: AuthType.QWEN_OAUTH },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'missing')).toBe(false);
    });

    it('does not match fast-only or voice-only models', () => {
      const config = makeConfig({ authType: AuthType.QWEN_OAUTH }, [
        { id: 'qwen-fast', authType: AuthType.QWEN_OAUTH, fastOnly: true },
        { id: 'qwen-voice', authType: AuthType.QWEN_OAUTH, voiceOnly: true },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'qwen-fast')).toBe(false);
      expect(isInlineModelOverrideAllowed(config, 'qwen-voice')).toBe(false);
    });

    it('rejects when no active auth type is available', () => {
      const config = makeConfig(undefined, []);
      expect(isInlineModelOverrideAllowed(config, 'anything')).toBe(false);
    });
  });
});
