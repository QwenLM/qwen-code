/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import {
  getEffectiveOmniUploadConfig,
  normalizeDedicatedOmniUploadConfig,
  OmniUploadConfigError,
} from './upload-config.js';

const DASH_SCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

function stubSelfHostedOssEnv(): void {
  vi.stubEnv('OMNI_OSS_ENDPOINT', 'oss-cn-shanghai-internal.aliyuncs.com');
  vi.stubEnv('OMNI_OSS_BUCKET', 'test-bucket');
  vi.stubEnv('OMNI_OSS_PREFIX', 'p/q');
  vi.stubEnv('OMNI_OSS_ACCESS_KEY_ID', 'ak-test');
  vi.stubEnv('OMNI_OSS_ACCESS_KEY_SECRET', 'sk-test');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('normalizeDedicatedOmniUploadConfig', () => {
  it('returns undefined when no dedicated upload setting is present', () => {
    expect(normalizeDedicatedOmniUploadConfig({}, {})).toBeUndefined();
  });

  it('resolves a complete upload channel from the named environment variable', () => {
    expect(
      normalizeDedicatedOmniUploadConfig(
        {
          baseUrl: DASH_SCOPE_BASE_URL,
          apiKeyEnv: 'OMNI_UPLOAD_KEY',
          model: 'qwen3.5-omni-plus',
        },
        { OMNI_UPLOAD_KEY: 'upload-secret' },
      ),
    ).toEqual({
      baseUrl: DASH_SCOPE_BASE_URL,
      apiKey: 'upload-secret',
      model: 'qwen3.5-omni-plus',
    });
  });

  it.each([
    [{ baseUrl: DASH_SCOPE_BASE_URL }, /must all be set/],
    [
      {
        baseUrl: DASH_SCOPE_BASE_URL,
        apiKeyEnv: 'BAD-NAME',
        model: 'upload-model',
      },
      /valid environment variable name/,
    ],
    [
      {
        baseUrl: 'http://127.0.0.1:22002/v1',
        apiKeyEnv: 'OMNI_UPLOAD_KEY',
        model: 'upload-model',
      },
      /DashScope-compatible endpoint/,
    ],
  ])('rejects invalid explicit configuration %#', (raw, expected) => {
    expect(() =>
      normalizeDedicatedOmniUploadConfig(raw, {
        OMNI_UPLOAD_KEY: 'upload-secret',
      }),
    ).toThrow(expected);
  });

  it('fails clearly when the named key is unavailable without exposing a secret', () => {
    expect(() =>
      normalizeDedicatedOmniUploadConfig(
        {
          baseUrl: DASH_SCOPE_BASE_URL,
          apiKeyEnv: 'MISSING_UPLOAD_KEY',
          model: 'upload-model',
        },
        {},
      ),
    ).toThrow(OmniUploadConfigError);
    expect(() =>
      normalizeDedicatedOmniUploadConfig(
        {
          baseUrl: DASH_SCOPE_BASE_URL,
          apiKeyEnv: 'MISSING_UPLOAD_KEY',
          model: 'upload-model',
        },
        {},
      ),
    ).toThrow(/MISSING_UPLOAD_KEY.*not set or is empty/);
  });
});

describe('getEffectiveOmniUploadConfig', () => {
  it('prefers the dedicated upload channel over custom inference', () => {
    const dedicated = {
      baseUrl: DASH_SCOPE_BASE_URL,
      apiKey: 'upload-key',
      model: 'upload-model',
    };
    const config = {
      getOmniUploadConfig: () => dedicated,
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        apiKey: 'inference-key',
        baseUrl: 'http://127.0.0.1:22002/v1',
      }),
      getModel: () => 'qwen4-omni-120b-think',
    } as unknown as Config;

    expect(getEffectiveOmniUploadConfig(config)).toBe(dedicated);
  });

  it('resolves a self-hosted bucket for an endpoint that cannot read oss://', () => {
    stubSelfHostedOssEnv();
    const config = {
      getOmniUploadConfig: () => undefined,
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        apiKey: 'inference-key',
        baseUrl: 'http://127.0.0.1:22002/v1',
      }),
      getModel: () => 'qwen4-omni-120b-think',
    } as unknown as Config;

    expect(getEffectiveOmniUploadConfig(config)).toMatchObject({
      baseUrl: 'https://test-bucket.oss-cn-shanghai-internal.aliyuncs.com',
      apiKey: 'ak-test',
      model: 'qwen4-omni-120b-think',
      selfHostedOss: { bucket: 'test-bucket', prefix: 'p/q' },
    });
  });

  it('lets a self-hosted bucket override DashScope inference credentials', () => {
    stubSelfHostedOssEnv();
    const config = {
      getOmniUploadConfig: () => undefined,
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        apiKey: 'legacy-key',
        baseUrl: DASH_SCOPE_BASE_URL,
      }),
      getModel: () => 'qwen3.5-omni-plus',
    } as unknown as Config;

    expect(getEffectiveOmniUploadConfig(config)?.selfHostedOss).toBeDefined();
  });

  it('keeps the dedicated channel ahead of a self-hosted bucket', () => {
    stubSelfHostedOssEnv();
    const dedicated = {
      baseUrl: DASH_SCOPE_BASE_URL,
      apiKey: 'upload-key',
      model: 'upload-model',
    };
    const config = {
      getOmniUploadConfig: () => dedicated,
      getModel: () => 'qwen4-omni-120b-think',
    } as unknown as Config;

    expect(getEffectiveOmniUploadConfig(config)).toBe(dedicated);
  });

  it('preserves the legacy static DashScope inference configuration', () => {
    const config = {
      getOmniUploadConfig: () => undefined,
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        apiKey: 'legacy-key',
        baseUrl: DASH_SCOPE_BASE_URL,
      }),
      getModel: () => 'qwen3.5-omni-plus',
    } as unknown as Config;

    expect(getEffectiveOmniUploadConfig(config)).toEqual({
      baseUrl: DASH_SCOPE_BASE_URL,
      apiKey: 'legacy-key',
      model: 'qwen3.5-omni-plus',
    });
  });
});
