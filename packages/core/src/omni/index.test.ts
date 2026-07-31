/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { isOmniVideoDeliveryActive } from './index.js';

function stubConfig(overrides: {
  omniEnabled?: boolean;
  trusted?: boolean | undefined;
  cgc?: Record<string, unknown> | undefined;
}): Config {
  return {
    isOmniEnabled: vi.fn().mockReturnValue(overrides.omniEnabled ?? true),
    isTrustedFolder: vi.fn().mockReturnValue(overrides.trusted),
    getContentGeneratorConfig: vi.fn().mockReturnValue(overrides.cgc),
  } as unknown as Config;
}

const DASHSCOPE_CGC = {
  authType: AuthType.USE_OPENAI,
  apiKey: 'sk-real-key',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

afterEach(() => {
  delete process.env['QWEN_CODE_ENABLE_OMNI'];
});

describe('isOmniVideoDeliveryActive', () => {
  it('is active for a DashScope endpoint with a static API key in a trusted workspace', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ trusted: true, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(true);
  });

  it('is inactive when omni is disabled', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ omniEnabled: false, trusted: true, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(false);
  });

  it('is inactive in an untrusted workspace', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ trusted: false, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(false);
  });

  it('treats unknown trust (undefined) as trusted', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({ trusted: undefined, cgc: DASHSCOPE_CGC }),
      ),
    ).toBe(true);
  });

  it('is inactive under Qwen OAuth even though a placeholder apiKey exists', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: {
            authType: AuthType.QWEN_OAUTH,
            apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive when the apiKey is the OAuth placeholder regardless of authType', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: { ...DASHSCOPE_CGC, apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN' },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive without a baseUrl (never sends the key to a default origin)', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: { authType: AuthType.USE_OPENAI, apiKey: 'sk-openai-key' },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive for non-DashScope endpoints', () => {
    expect(
      isOmniVideoDeliveryActive(
        stubConfig({
          trusted: true,
          cgc: {
            authType: AuthType.USE_OPENAI,
            apiKey: 'sk-openai-key',
            baseUrl: 'https://api.openai.com/v1',
          },
        }),
      ),
    ).toBe(false);
  });

  it('is inactive without a content generator config', () => {
    expect(
      isOmniVideoDeliveryActive(stubConfig({ trusted: true, cgc: undefined })),
    ).toBe(false);
  });
});
