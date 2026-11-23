/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './provider/default.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { AuthType } from '../../utils/auth-type.js';
import type { Config } from '../../config/config.js';
import { getErrorStatus } from '../../utils/errors.js';
import { classifyRetryError } from '../../utils/retryErrorClassification.js';
import { getRateLimitErrorDetails } from '../../utils/rateLimit.js';

const SGLANG_MESSAGE =
  "The input (90000 tokens) is longer than the model's context length (32768 tokens).";
const FLAT_ERROR = {
  object: 'error',
  message: SGLANG_MESSAGE,
  code: 400,
};

let server: Server;
let baseUrl: string;
let responseMode: 'flat' | 'envelope';
let requestCount: number;

beforeAll(async () => {
  const { preloadRuntimeFetchModule } = await import(
    '../../utils/runtimeFetchOptions.js'
  );
  await preloadRuntimeFetchModule();

  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requestCount += 1;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          responseMode === 'flat'
            ? FLAT_ERROR
            : {
                error: {
                  message: 'invalid request',
                  type: 'invalid_request_error',
                  code: null,
                },
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

beforeEach(() => {
  responseMode = 'flat';
  requestCount = 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function createGenerator(): OpenAIContentGenerator {
  const contentGeneratorConfig: ContentGeneratorConfig = {
    model: 'test-model',
    apiKey: 'test-key',
    baseUrl,
    authType: AuthType.USE_OPENAI,
    maxRetries: 0,
  };
  const cliConfig = {
    getCliVersion: () => '0.0.0-test',
    getProxy: () => undefined,
    getSessionId: () => 'test-session',
  } as unknown as Config;
  const provider = new DefaultOpenAICompatibleProvider(
    contentGeneratorConfig,
    cliConfig,
  );
  return new OpenAIContentGenerator(
    contentGeneratorConfig,
    cliConfig,
    provider,
  );
}

async function captureFailure(streaming: boolean): Promise<unknown> {
  const generator = createGenerator();
  const contents: Content[] = [
    { role: 'user', parts: [{ text: 'context overflow' }] },
  ];
  try {
    if (!streaming) {
      await generator.generateContent(
        { model: 'test-model', contents },
        'prompt-flat-error',
      );
    } else {
      const stream = await generator.generateContentStream(
        { model: 'test-model', contents },
        'prompt-flat-error-stream',
      );
      for await (const chunk of stream) {
        void chunk;
      }
    }
  } catch (error) {
    return error;
  }
  throw new Error('Expected the flat 400 response to fail');
}

describe('flat OpenAI-compatible error responses', () => {
  it.each([false, true])(
    'preserves the SGLang body and fail-fast classification (streaming=%s)',
    async (streaming) => {
      const caught = await captureFailure(streaming);

      expect(getErrorStatus(caught)).toBe(400);
      expect(caught).toMatchObject({
        error: {
          object: 'error',
          message: SGLANG_MESSAGE,
          code: 400,
        },
      });
      expect(getRateLimitErrorDetails(caught).providerMessage).toBe(
        SGLANG_MESSAGE,
      );
      expect(classifyRetryError(caught)).toMatchObject({
        diagnosis: 'fail-fast',
        reason: 'client-error',
        statusCode: 400,
      });
      expect(requestCount).toBe(1);
    },
  );

  it('leaves an existing OpenAI error envelope unchanged', async () => {
    responseMode = 'envelope';
    const caught = await captureFailure(false);

    expect(getErrorStatus(caught)).toBe(400);
    expect(caught).toMatchObject({
      error: {
        message: 'invalid request',
        type: 'invalid_request_error',
        code: null,
      },
    });
    expect(getRateLimitErrorDetails(caught)).toMatchObject({
      providerMessage: 'invalid request',
    });
    expect(classifyRetryError(caught).reason).toBe('client-error');
    expect(requestCount).toBe(1);
  });
});
