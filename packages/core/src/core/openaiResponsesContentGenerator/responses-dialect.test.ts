/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DASHSCOPE_RESPONSES_DIALECT,
  OPENAI_RESPONSES_DIALECT,
  resolveResponsesWireDialect,
} from './responses-dialect.js';

describe('responses-dialect', () => {
  const originalProxyEnv = process.env['DASHSCOPE_PROXY_BASE_URL'];
  beforeEach(() => delete process.env['DASHSCOPE_PROXY_BASE_URL']);
  afterEach(() => {
    if (originalProxyEnv === undefined) {
      delete process.env['DASHSCOPE_PROXY_BASE_URL'];
    } else {
      process.env['DASHSCOPE_PROXY_BASE_URL'] = originalProxyEnv;
    }
  });

  it.each([
    [OPENAI_RESPONSES_DIALECT, 'openai', 'raw_base64', false],
    [DASHSCOPE_RESPONSES_DIALECT, 'dashscope', 'data_uri', true],
  ] as const)(
    'exports frozen %s capability descriptor',
    (dialect, name, encoding, extended) => {
      expect(Object.isFrozen(dialect)).toBe(true);
      expect(dialect).toMatchObject({
        name,
        inlineAudioEncoding: encoding,
        supportsFileAudio: extended,
        supportsInputVideo: extended,
        supportsPlaintextReasoningReplay: extended,
        downgradeRequiredToolChoiceOnReasoning: extended,
        supportsOssResourceResolveHeader: extended,
      });
      expect(dialect.inlineAudioFormats.has('wav')).toBe(true);
      expect(dialect.inlineAudioFormats.has('aac')).toBe(extended);
    },
  );

  it.each([
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'https://cn-beijing.maas.aliyuncs.com/v1',
    'https://maas.qwencloudapi.com/v1',
  ])('resolves DashScope host %s', (url) => {
    expect(resolveResponsesWireDialect(url)).toBe(DASHSCOPE_RESPONSES_DIALECT);
  });

  it.each([
    undefined,
    '',
    'https://api.openai.com/v1',
    'http://127.0.0.1:8000/v1',
    'https://openrouter.ai/api/v1',
  ])('resolves %s to strict OpenAI dialect', (url) => {
    expect(resolveResponsesWireDialect(url)).toBe(OPENAI_RESPONSES_DIALECT);
  });

  it('respects DASHSCOPE_PROXY_BASE_URL env (including trailing slash) without breaking unset baseUrl', () => {
    const proxy = 'https://env-proxy.example/v1';
    process.env['DASHSCOPE_PROXY_BASE_URL'] = proxy;
    expect(resolveResponsesWireDialect(proxy)).toBe(
      DASHSCOPE_RESPONSES_DIALECT,
    );
    expect(resolveResponsesWireDialect(`${proxy}/`)).toBe(
      DASHSCOPE_RESPONSES_DIALECT,
    );
    expect(resolveResponsesWireDialect(undefined)).toBe(
      OPENAI_RESPONSES_DIALECT,
    );
    expect(resolveResponsesWireDialect('https://api.openai.com/v1')).toBe(
      OPENAI_RESPONSES_DIALECT,
    );
  });
});
