/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../utils/auth-type.js';
import { retryContext } from '../utils/retryContext.js';
import { getSystemPromptModel } from './request-model.js';

describe('getSystemPromptModel', () => {
  it.each([AuthType.USE_OPENAI, AuthType.QWEN_OAUTH])(
    'follows Chat override precedence for %s',
    (authType) => {
      expect(
        getSystemPromptModel(
          {
            authType,
            model: 'configured',
            samplingParams: { model: 'sampling' },
            extra_body: { model: 'wire' },
          },
          'requested',
        ),
      ).toBe('wire');
    },
  );

  it.each([AuthType.USE_ANTHROPIC, AuthType.USE_OPENAI_RESPONSES])(
    'uses the configured wire model for %s',
    (authType) => {
      expect(
        getSystemPromptModel({ authType, model: 'configured' }, 'requested'),
      ).toBe('configured');
    },
  );

  it.each([AuthType.USE_GEMINI, AuthType.USE_VERTEX_AI])(
    'preserves the request model for %s',
    (authType) => {
      expect(
        getSystemPromptModel(
          { authType, model: 'configured', extra_body: { model: 'ignored' } },
          'requested',
        ),
      ).toBe('requested');
    },
  );

  it('follows subscription extra-body overrides without sampling overrides', () => {
    const generation = {
      authType: AuthType.QWEN_SUBSCRIPTION,
      model: 'configured',
      samplingParams: { model: 'sampling' },
    };
    expect(getSystemPromptModel(generation, 'requested')).toBe('requested');
    expect(
      getSystemPromptModel(
        { ...generation, extra_body: { model: 'wire' } },
        'requested',
      ),
    ).toBe('wire');
    expect(
      retryContext.run(
        {
          attempt: 1,
          retryTotalDelayMs: 0,
          requestSetupMs: 0,
          singleAttempt: true,
        },
        () =>
          getSystemPromptModel(
            { ...generation, extra_body: { model: 'wire' } },
            'requested',
          ),
      ),
    ).toBe('requested');
  });
});
