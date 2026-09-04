/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './provider/default.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { AuthType } from '../../utils/auth-type.js';
import type { Config } from '../../config/config.js';
import { getContextLengthExceededInfo } from '../../utils/contextLengthError.js';
import { getRequestPayloadTooLargeInfo } from '../../utils/request-payload-error.js';
import { getErrorStatus } from '../../utils/errors.js';

/**
 * End-to-end repro for #10380: an OpenAI-compatible endpoint behind a
 * reverse proxy with a request-body byte limit. A real local HTTP server
 * plays the proxy: bodies above `BODY_LIMIT_BYTES` get an HTML 413 page,
 * smaller bodies get a valid chat completion. Drives the real OpenAI SDK +
 * pipeline path, then asserts the classification chain the reactive
 * compaction recovery in llm-chat depends on.
 */

const BODY_LIMIT_BYTES = 8 * 1024;

const HTML_413_PAGE =
  '<html>\n<head><title>413 Request Entity Too Large</title></head>\n' +
  '<body>\n<center><h1>413 Request Entity Too Large</h1></center>\n' +
  '<hr><center>nginx/1.24.0</center>\n</body>\n</html>';

let server: Server;
let baseUrl: string;
let receivedBodyBytes: number | undefined;

beforeAll(async () => {
  // Same bootstrap as the app entrypoint: buildClient installs an undici
  // dispatcher, which requires the runtime fetch module to be preloaded.
  const { preloadRuntimeFetchModule } = await import(
    '../../utils/runtimeFetchOptions.js'
  );
  await preloadRuntimeFetchModule();

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      receivedBodyBytes = body.byteLength;
      if (body.byteLength > BODY_LIMIT_BYTES) {
        res.writeHead(413, { 'Content-Type': 'text/html' });
        res.end(HTML_413_PAGE);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11,
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
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

describe('issue #10380: gateway HTTP 413 on the real OpenAI provider path', () => {
  it('accepts a request under the proxy byte limit (harness sanity)', async () => {
    const generator = createGenerator();
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'small prompt' }] },
    ];
    const response = await generator.generateContent(
      { model: 'test-model', contents },
      'prompt-413-small',
    );
    expect(
      response.candidates?.[0]?.content?.parts?.some(
        (part) => part.text === 'ok',
      ),
    ).toBe(true);
    expect(receivedBodyBytes).toBeLessThanOrEqual(BODY_LIMIT_BYTES);
  });

  it('rejects an oversized request with an HTML 413 the old detector does not recognize', async () => {
    const generator = createGenerator();
    // Token-cheap but byte-heavy history: below any token-based
    // compaction threshold, over the 8KB proxy limit once serialized.
    const bigText = 'A'.repeat(64 * 1024);
    const contents: Content[] = [
      { role: 'user', parts: [{ text: bigText }] },
      { role: 'model', parts: [{ text: 'ack' }] },
      { role: 'user', parts: [{ text: 'follow-up prompt' }] },
    ];

    let caught: unknown;
    try {
      await generator.generateContent(
        { model: 'test-model', contents },
        'prompt-413-oversized',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(receivedBodyBytes).toBeGreaterThan(BODY_LIMIT_BYTES);
    // The SDK surfaces the proxy rejection with a numeric status.
    expect(getErrorStatus(caught)).toBe(413);
    // Pre-fix gap: the token-wording detector never matches a bare 413,
    // so the reactive compaction path in llm-chat never fired.
    expect(getContextLengthExceededInfo(caught).isExceeded).toBe(false);
    // The typed model-request detector recognizes it, keeping the recovery
    // scoped to model requests (upload/file 413s never flow through here).
    expect(getRequestPayloadTooLargeInfo(caught).isTooLarge).toBe(true);
  });
});
