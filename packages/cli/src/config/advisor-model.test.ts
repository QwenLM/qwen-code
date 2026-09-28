/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import { checkAdvisorModelAvailability } from './advisor-model.js';

describe('checkAdvisorModelAvailability', () => {
  it('validates the selected endpoint without falling back to a same-name model', () => {
    const config = {
      getModel: () => 'advisor',
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        model: 'advisor',
      }),
      getAllConfiguredModels: () => [
        {
          id: 'advisor',
          authType: AuthType.USE_OPENAI,
          registryBaseUrl: 'https://a.example/v1',
          voiceOnly: true,
        },
        {
          id: 'advisor',
          authType: AuthType.USE_OPENAI,
          registryBaseUrl: 'https://b.example/v1',
        },
        { id: 'advisor', authType: AuthType.USE_OPENAI, isRuntimeModel: true },
      ],
    } as unknown as Config;
    expect(
      checkAdvisorModelAvailability(
        config,
        'openai:advisor\0https://b.example/v1',
      ).available,
    ).toBe(true);
    expect(
      checkAdvisorModelAvailability(
        config,
        'openai:advisor\0https://a.example/v1',
      ).available,
    ).toBe(false);
    expect(
      checkAdvisorModelAvailability(
        config,
        'openai:advisor\0https://missing.example/v1',
      ).available,
    ).toBe(false);
    expect(
      checkAdvisorModelAvailability(config, 'openai:advisor\0').available,
    ).toBe(false);
    config.getAllConfiguredModels = () => [
      { id: 'advisor', authType: AuthType.USE_OPENAI, label: 'Advisor' },
    ];
    expect(
      checkAdvisorModelAvailability(config, 'openai:advisor\0').available,
    ).toBe(true);
  });

  it('rejects inheriting the executor model', () => {
    const config = {
      getModel: vi.fn(() => 'executor-model'),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'executor-model',
      })),
      getAllConfiguredModels: vi.fn(() => [
        { id: 'executor-model', authType: AuthType.USE_OPENAI },
      ]),
    } as unknown as Config;

    expect(checkAdvisorModelAvailability(config, 'inherit').available).toBe(
      false,
    );
  });

  it('allows the active runtime model', () => {
    const config = {
      getModel: vi.fn(() => 'runtime-advisor'),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'runtime-advisor',
      })),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'runtime-advisor',
          authType: AuthType.USE_OPENAI,
          isRuntimeModel: true,
        },
      ]),
    } as unknown as Config;

    expect(checkAdvisorModelAvailability(config, 'runtime-advisor')).toEqual({
      available: true,
      availableModelIds: ['runtime-advisor'],
    });
  });

  it('allows the configured fast model after it is persisted as a concrete selector', () => {
    const configuredModels = [
      {
        id: 'fast-advisor-model',
        label: 'Fast Advisor Model',
        authType: AuthType.USE_OPENAI,
        fastOnly: true,
      },
    ];
    const config = {
      getModel: vi.fn(() => 'executor-model'),
      getFastModel: vi.fn(() => `${AuthType.USE_OPENAI}:fast-advisor-model`),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'executor-model',
      })),
      getAllConfiguredModels: vi.fn((authTypes?: AuthType[]) =>
        authTypes
          ? configuredModels.filter((model) =>
              authTypes.includes(model.authType),
            )
          : configuredModels,
      ),
    } as unknown as Config;

    expect(
      checkAdvisorModelAvailability(
        config,
        `${AuthType.USE_OPENAI}:fast-advisor-model`,
      ),
    ).toEqual({
      available: true,
      availableModelIds: ['fast-advisor-model'],
    });
  });
});
