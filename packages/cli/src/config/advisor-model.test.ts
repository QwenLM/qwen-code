/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import { checkAdvisorModelAvailability } from './advisor-model.js';

describe('checkAdvisorModelAvailability', () => {
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
