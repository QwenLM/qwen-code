/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { getAuthTypeFromEnv } from './modelConfigUtils.js';

describe('getAuthTypeFromEnv', () => {
  it('infers openai with OPENAI_API_KEY only', () => {
    expect(getAuthTypeFromEnv({ OPENAI_API_KEY: 'k' })).toBe(
      AuthType.USE_OPENAI,
    );
  });

  it('infers qwen-oauth when QWEN_OAUTH is set', () => {
    expect(getAuthTypeFromEnv({ QWEN_OAUTH: '1' })).toBe(AuthType.QWEN_OAUTH);
  });

  it('does not infer gemini when GEMINI_MODEL is missing', () => {
    expect(getAuthTypeFromEnv({ GEMINI_API_KEY: 'k' })).toBeUndefined();
  });

  it('infers gemini when GEMINI_API_KEY and GEMINI_MODEL are set', () => {
    expect(getAuthTypeFromEnv({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm' })).toBe(
      AuthType.USE_GEMINI,
    );
  });

  it('does not infer vertex-ai when GOOGLE_MODEL is missing', () => {
    expect(getAuthTypeFromEnv({ GOOGLE_API_KEY: 'k' })).toBeUndefined();
  });

  it('infers vertex-ai when GOOGLE_API_KEY and GOOGLE_MODEL are set', () => {
    expect(getAuthTypeFromEnv({ GOOGLE_API_KEY: 'k', GOOGLE_MODEL: 'm' })).toBe(
      AuthType.USE_VERTEX_AI,
    );
  });

  it('does not infer anthropic when required env vars are missing', () => {
    expect(getAuthTypeFromEnv({ ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(
      getAuthTypeFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' }),
    ).toBeUndefined();
  });

  it('infers anthropic when required env vars are set', () => {
    expect(
      getAuthTypeFromEnv({
        ANTHROPIC_API_KEY: 'k',
        ANTHROPIC_MODEL: 'm',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.example.com/v1',
      }),
    ).toBe(AuthType.USE_ANTHROPIC);
  });
});
