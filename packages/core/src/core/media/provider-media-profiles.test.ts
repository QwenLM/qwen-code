/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';
import {
  getMediaProfile,
  estimateModalityTokens,
} from './provider-media-profiles.js';

function configWith(authType?: AuthType, baseUrl?: string): Config {
  return {
    getContentGeneratorConfig: () => ({ authType, baseUrl }),
  } as unknown as Config;
}

describe('provider-media-profiles', () => {
  it('selects the qwen profile for qwen-oauth', () => {
    expect(getMediaProfile(configWith(AuthType.QWEN_OAUTH)).id).toBe('qwen-vl');
  });

  it('selects the qwen profile for openai auth on a dashscope base url', () => {
    const p = getMediaProfile(
      configWith(
        AuthType.USE_OPENAI,
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ),
    );
    expect(p.id).toBe('qwen-vl');
  });

  it('selects openai for generic openai auth', () => {
    expect(
      getMediaProfile(
        configWith(AuthType.USE_OPENAI, 'https://api.openai.com/v1'),
      ).id,
    ).toBe('openai');
  });

  it('selects gemini and anthropic by auth type', () => {
    expect(getMediaProfile(configWith(AuthType.USE_GEMINI)).id).toBe('gemini');
    expect(getMediaProfile(configWith(AuthType.USE_ANTHROPIC)).id).toBe(
      'anthropic',
    );
  });

  it('anthropic cannot fetch a fileUri; qwen can', () => {
    expect(
      getMediaProfile(configWith(AuthType.USE_ANTHROPIC)).supportsFileUri,
    ).toBe(false);
    expect(
      getMediaProfile(configWith(AuthType.QWEN_OAUTH)).supportsFileUri,
    ).toBe(true);
  });

  it('falls back to a default profile when nothing matches', () => {
    expect(getMediaProfile(configWith(undefined)).id).toBe('default');
  });

  it('estimates tokens per modality from the profile', () => {
    const p = getMediaProfile(configWith(AuthType.QWEN_OAUTH));
    expect(estimateModalityTokens(p, 'image', 1)).toBe(p.tokensPerImage);
    expect(estimateModalityTokens(p, 'video', 10)).toBe(
      p.tokensPerVideoSecond * 10,
    );
  });
});
