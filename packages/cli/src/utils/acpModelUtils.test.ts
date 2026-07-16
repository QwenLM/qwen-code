/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import {
  buildAcpModelOptions,
  getCurrentAcpModelId,
  isInlineModelOverrideAllowed,
  parseAcpBaseModelId,
  parseAcpModelOption,
  resolveAcpModelOption,
  sanitizeProviderBaseUrl,
} from './acpModelUtils.js';

describe('acpModelUtils', () => {
  it('uses opaque ids only to disambiguate colliding model routes', () => {
    const models = [
      {
        id: 'shared-model',
        label: 'Provider One',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://one.example/v1',
        registryBaseUrl: 'https://one.example/v1',
      },
      {
        id: 'shared-model',
        label: 'Provider Two',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://user:secret@two.example/v1?token=value',
        registryBaseUrl: 'https://user:secret@two.example/v1?token=value',
      },
      {
        id: 'unique-model',
        label: 'Unique',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://three.example/v1',
        registryBaseUrl: 'https://three.example/v1',
      },
    ];

    const options = buildAcpModelOptions(models);
    const [first, second, unique] = options;

    expect(first?.modelId).toMatch(/^qwen-route:v1:/);
    expect(second?.modelId).toMatch(/^qwen-route:v1:/);
    expect(first?.modelId).not.toBe(second?.modelId);
    expect(unique?.modelId).toBe(`unique-model(${AuthType.USE_OPENAI})`);
    expect(options.map((option) => option.modelId).join(' ')).not.toContain(
      'secret',
    );
    expect(resolveAcpModelOption(second!.modelId, models)).toMatchObject({
      modelId: 'shared-model',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://user:secret@two.example/v1?token=value',
    });
    expect(
      getCurrentAcpModelId(
        options,
        'shared-model',
        AuthType.USE_OPENAI,
        'https://user:secret@two.example/v1?token=value',
      ),
    ).toBe(second?.modelId);
    expect(
      buildAcpModelOptions([...models].reverse()).find(
        (option) =>
          option.model.baseUrl ===
          'https://user:secret@two.example/v1?token=value',
      )?.modelId,
    ).toBe(second?.modelId);
  });

  it('keeps opaque ids unique when colliding routes have identical metadata', () => {
    const models = [
      {
        id: 'shared-model',
        label: 'shared-model',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://one.example/v1',
        registryBaseUrl: 'https://one.example/v1',
      },
      {
        id: 'shared-model',
        label: 'shared-model',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://two.example/v1',
        registryBaseUrl: 'https://two.example/v1',
      },
    ];

    const options = buildAcpModelOptions(models);

    expect(new Set(options.map((option) => option.modelId))).toHaveLength(2);
    expect(resolveAcpModelOption(options[0]!.modelId, models)?.baseUrl).toBe(
      'https://one.example/v1',
    );
    expect(resolveAcpModelOption(options[1]!.modelId, models)?.baseUrl).toBe(
      'https://two.example/v1',
    );
    const reversed = buildAcpModelOptions([...models].reverse());
    expect(
      reversed.find(
        (option) => option.model.baseUrl === 'https://one.example/v1',
      )?.modelId,
    ).toBe(options[0]?.modelId);
  });

  it('binds opaque ids to credential-free endpoint identity', () => {
    const makeModels = (suffix: string) => [
      {
        id: 'shared-model',
        label: 'Provider One',
        authType: AuthType.USE_OPENAI,
        baseUrl: `https://one.example/${suffix}`,
        registryBaseUrl: `https://one.example/${suffix}`,
      },
      {
        id: 'shared-model',
        label: 'Provider Two',
        authType: AuthType.USE_OPENAI,
        baseUrl: `https://two.example/${suffix}`,
        registryBaseUrl: `https://two.example/${suffix}`,
      },
    ];

    expect(
      buildAcpModelOptions(makeModels('first')).map((option) => option.modelId),
    ).not.toEqual(
      buildAcpModelOptions(makeModels('changed')).map(
        (option) => option.modelId,
      ),
    );

    const withSecrets = makeModels('first').map((model, index) => ({
      ...model,
      baseUrl: model.baseUrl
        .replace('https://', `https://user:secret-${index}@`)
        .concat(`?token=${index}`),
      registryBaseUrl: model.registryBaseUrl
        .replace('https://', `https://user:secret-${index}@`)
        .concat(`?token=${index}`),
    }));
    expect(
      buildAcpModelOptions(withSecrets).map((option) => option.modelId),
    ).toEqual(
      buildAcpModelOptions(makeModels('first')).map((option) => option.modelId),
    );
  });

  it('rejects colliding routes that differ only by secret URL parts', () => {
    const models = ['one', 'two'].map((token) => ({
      id: 'shared-model',
      label: 'Shared',
      authType: AuthType.USE_OPENAI,
      envKey: 'SHARED_KEY',
      baseUrl: `https://user:${token}@api.example/v1?token=${token}`,
      registryBaseUrl: `https://user:${token}@api.example/v1?token=${token}`,
    }));

    expect(() => buildAcpModelOptions(models)).toThrow(
      'need distinct names, envKey values, or public endpoints',
    );
  });

  it('keeps resolved defaults separate from the registry route key', () => {
    const models = [
      {
        id: 'shared-model',
        label: 'Default Route',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://default.example/v1',
      },
      {
        id: 'shared-model',
        label: 'Explicit Route',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://default.example/v1',
        registryBaseUrl: 'https://default.example/v1',
      },
    ];
    const options = buildAcpModelOptions(models);

    expect(options[0]?.modelId).not.toBe(options[1]?.modelId);
    expect(
      resolveAcpModelOption(options[0]!.modelId, models),
    ).not.toHaveProperty('baseUrl');
    expect(
      getCurrentAcpModelId(options, 'shared-model', AuthType.USE_OPENAI, null),
    ).toBe(options[0]?.modelId);
    expect(
      getCurrentAcpModelId(
        options,
        'shared-model',
        AuthType.USE_OPENAI,
        'https://default.example/v1',
      ),
    ).toBe(options[1]?.modelId);
    expect(
      getCurrentAcpModelId(
        options,
        'shared-model',
        AuthType.USE_OPENAI,
        'https://outside.example/v1',
      ),
    ).toBe('shared-model');
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
