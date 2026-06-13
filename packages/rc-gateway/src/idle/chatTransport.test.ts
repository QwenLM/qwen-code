/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSuggestConfig,
  createChatTransport,
  type SuggestConfig,
} from './chatTransport.js';

describe('resolveSuggestConfig — coherent (key, host) sets only', () => {
  it('tier 1: dedicated QWEN_RC_SUGGEST_* key+base (trailing slash trimmed)', () => {
    expect(
      resolveSuggestConfig({
        QWEN_RC_SUGGEST_API_KEY: 'k1',
        QWEN_RC_SUGGEST_BASE_URL: 'https://host.example/v1/',
        QWEN_RC_SUGGEST_MODEL: 'qwen-plus',
      }),
    ).toEqual({
      apiKey: 'k1',
      baseUrl: 'https://host.example/v1',
      model: 'qwen-plus',
    });
  });

  it('tier 2: OPENAI_* key+base together', () => {
    expect(
      resolveSuggestConfig({
        OPENAI_API_KEY: 'ok',
        OPENAI_BASE_URL: 'https://oai.example/v1',
        OPENAI_MODEL: 'gpt-x',
      }),
    ).toEqual({
      apiKey: 'ok',
      baseUrl: 'https://oai.example/v1',
      model: 'gpt-x',
    });
  });

  it('tier 3: DASHSCOPE_API_KEY alone → the unambiguous dashscope base', () => {
    const cfg = resolveSuggestConfig({ DASHSCOPE_API_KEY: 'dk' });
    expect(cfg?.apiKey).toBe('dk');
    expect(cfg?.baseUrl).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(cfg?.model).toBe('qwen-turbo'); // default
  });

  it('NEVER mixes a key from one source with a host from another', () => {
    // OPENAI_API_KEY with NO base → would have to guess a host → inert.
    expect(resolveSuggestConfig({ OPENAI_API_KEY: 'ok' })).toBeNull();
    // Dedicated key alone (no dedicated base) → inert.
    expect(resolveSuggestConfig({ QWEN_RC_SUGGEST_API_KEY: 'k' })).toBeNull();
    // A base alone (no key) → inert.
    expect(
      resolveSuggestConfig({ QWEN_RC_SUGGEST_BASE_URL: 'https://h/v1' }),
    ).toBeNull();
  });

  it('no credentials → null (feature inert)', () => {
    expect(resolveSuggestConfig({})).toBeNull();
  });

  it('QWEN_RC_SUGGEST_MODEL overrides the model even on the dashscope tier', () => {
    expect(
      resolveSuggestConfig({
        DASHSCOPE_API_KEY: 'dk',
        QWEN_RC_SUGGEST_MODEL: 'qwen-max',
      })?.model,
    ).toBe('qwen-max');
  });
});

describe('createChatTransport', () => {
  const cfg: SuggestConfig = {
    apiKey: 'secret',
    baseUrl: 'https://host.example/v1',
    model: 'qwen-turbo',
  };

  it('POSTs to /chat/completions with bearer + model + messages and returns the content', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '["A","B"]' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const chat = createChatTransport(cfg, { fetchImpl: fakeFetch });
    const out = await chat([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('["A","B"]');
    expect(captured!.url).toBe('https://host.example/v1/chat/completions');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret');
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe('qwen-turbo');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('throws on a non-2xx response (caller maps to no-suggestions)', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const chat = createChatTransport(cfg, { fetchImpl: fakeFetch });
    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('returns "" when the response has no string content', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ choices: [{}] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const chat = createChatTransport(cfg, { fetchImpl: fakeFetch });
    expect(await chat([{ role: 'user', content: 'x' }])).toBe('');
  });

  it('fires its own timeout on a hung endpoint (load-bearing for the pump)', async () => {
    // A fetch that never resolves on its own, but honors the composed signal —
    // proves the 15 s AbortSignal.timeout (overridden tiny here) actually aborts,
    // so a hung endpoint can never wedge the caller.
    const fakeFetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;
    const chat = createChatTransport(cfg, { fetchImpl: fakeFetch });
    await expect(
      chat([{ role: 'user', content: 'x' }], { timeoutMs: 20 }),
    ).rejects.toThrow();
  });

  it('honors an already-aborted caller signal', async () => {
    // The transport composes the caller signal with its timeout via
    // AbortSignal.any; a pre-aborted caller signal must reject the fetch.
    const chat = createChatTransport(cfg, { fetchImpl: fetch });
    await expect(
      chat([{ role: 'user', content: 'x' }], {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });
});
