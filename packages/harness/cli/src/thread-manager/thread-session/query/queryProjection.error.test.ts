/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ChatCompletionsTransport,
  CustomApiImpl,
  CustomModelProvider,
  CustomProviderConfig,
  CustomResponse,
  ModelInferenceError,
  ModelTransportManager,
  OPENAI_CHAT_COMPLETIONS,
  type Model,
} from '@qwen-code/core';
import { SettingsService } from '@qwen-code/resource';
import { buildResultError } from './queryProjection.js';

describe('Provider error result projection', () => {
  it.each(['112', '140', 'EXTERNAL_TOKEN_RATE_LIMITED', undefined])(
    'forwards the original code %s without parsing the message or HTTP status',
    (code) => {
      const error = new ModelInferenceError('HTTP 503', {
        code,
        kind: 'server',
        status: 503,
        phase: 'before_output',
      });
      const result = buildResultError(
        'error_during_execution',
        {
          error,
          errors: [error.message],
          durationMs: 0,
          numTurns: 0,
        },
        'provider-error-session',
      );
      expect(result).toMatchObject({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
      });
      if (code === undefined) expect(result).not.toHaveProperty('error_code');
      else expect(result).toHaveProperty('error_code', code);
    },
  );
});

describe('Custom Provider CLI codes through the SDK result chain', () => {
  it.each([
    { status: 403, body: 'Forbidden', code: '200002' },
    { status: 200, body: 'data: not-json\n\n', code: '200006' },
  ])(
    'forwards $code from an HTTP response to the host result',
    async ({ status, body, code }) => {
      const model: Model = {
        source: 'custom',
        key: 'custom/test-model',
        displayName: 'Test model',
        capabilities: {
          tools: true,
          vision: false,
          reasoning: { supported: false, supportedEfforts: [] },
          contextWindows: [],
        },
        limits: { maxContextTokens: 8192 },
      };
      const provider = new CustomModelProvider({
        config: new CustomProviderConfig({
          providerId: 'custom',
          baseUrl: 'https://unused.invalid',
          protocol: OPENAI_CHAT_COMPLETIONS,
          models: [model],
        }),
        transportManager: new ModelTransportManager([
          new ChatCompletionsTransport(),
        ]),
        client: {
          api: new CustomApiImpl({
            execute: async () =>
              new CustomResponse({ raw: new Response(body, { status }) }),
            invoke: async () => {},
            insert: () => {},
            append: () => {},
          }),
        },
        settingsService: new SettingsService(),
        scope: 'user',
      });
      try {
        const response = await provider.inference({
          resolution: { model, config: {} },
          prompt: { messages: [{ role: 'user', content: 'hello' }] },
        });
        const error: unknown = await response.completed.catch(
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(ModelInferenceError);
        const result = buildResultError(
          'error_during_execution',
          {
            error,
            errors: [(error as Error).message],
            durationMs: 0,
            numTurns: 0,
          },
          'custom-provider-error-session',
        );
        expect(JSON.parse(JSON.stringify(result))).toMatchObject({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          error_code: code,
        });
      } finally {
        await provider.stop();
      }
    },
  );
});
