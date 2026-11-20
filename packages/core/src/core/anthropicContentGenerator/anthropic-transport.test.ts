/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../config/config.js';
import { AnthropicContentGenerator } from './anthropicContentGenerator.js';

const { dispatcher, runtimeFetch } = vi.hoisted(() => ({
  dispatcher: { dispatch: vi.fn() },
  runtimeFetch: vi.fn<typeof globalThis.fetch>(),
}));

vi.mock('../../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: () => ({
    fetch: runtimeFetch,
    fetchOptions: { dispatcher },
  }),
  redactProxyError: (error: unknown) => error,
}));

function createClient(): Anthropic {
  const generator = new AnthropicContentGenerator(
    {
      apiKey: 'test-key',
      baseUrl: 'https://routify-pub.alibaba-inc.com',
      model: 'test-model',
      timeout: 600000,
      maxRetries: 0,
    },
    {
      getCliVersion: () => 'test',
      getProxy: () => undefined,
      getSessionId: () => 'test-session',
    } as unknown as Config,
  );
  return (generator as unknown as { client: Anthropic }).client;
}

const message: Anthropic.MessageCreateParamsNonStreaming = {
  model: 'test-model',
  max_tokens: 1,
  messages: [{ role: 'user', content: 'OK' }],
};

describe('Anthropic SDK transport', () => {
  beforeEach(() => {
    runtimeFetch.mockReset();
  });

  it('passes the dispatcher and session headers to the actual SDK fetch', async () => {
    runtimeFetch.mockResolvedValueOnce(
      Response.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    const result = await createClient().messages.create(message);

    expect(result.content).toEqual([{ type: 'text', text: 'OK' }]);
    expect(runtimeFetch).toHaveBeenCalledOnce();
    const init = runtimeFetch.mock.calls[0][1] as RequestInit & {
      dispatcher?: unknown;
    };
    expect(init.method).toBe('POST');
    expect(init.dispatcher).toBe(dispatcher);
    expect(new Headers(init.headers).get('session_id')).toBe('test-session');
  });

  it('preserves caller cancellation through the SDK and fetch wrappers', async () => {
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    runtimeFetch.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
          started();
        }),
    );
    const controller = new AbortController();
    const request = createClient().messages.create(message, {
      signal: controller.signal,
    });
    const outcome = request.catch((error: unknown) => error);

    await requestStarted;
    controller.abort();

    expect(await outcome).toBeInstanceOf(Anthropic.APIUserAbortError);
    expect(runtimeFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
