/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getContextLengthExceededInfo,
  isContextLengthExceededError,
} from './contextLengthError.js';

describe('contextLengthError', () => {
  it.each([
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens.",
    'context_length_exceeded',
    'prompt is too long: 137500 tokens > 135000 maximum',
    'Range of input length should be [1, 30000]',
    'Input token length is too long',
    'The input token count (127234) exceeds the maximum number of tokens allowed (100000).',
    '{"error":{"code":"context_length_exceeded","message":"too many tokens in prompt"}}',
  ])('matches context overflow: %s', (message) => {
    expect(isContextLengthExceededError(new Error(message))).toBe(true);
  });

  it.each([
    'rate limit exceeded',
    'Throttling: TPM(1/1)',
    'connection timeout',
    'finishReason: MAX_TOKENS',
    'max_tokens',
    'Request failed: maximum schema depth exceeded',
    'Request contains an invalid argument',
    'context deadline exceeded',
    'deadline exceeded',
    'Request timeout after 60s. Try reducing input length or increasing timeout in config.',
    'connection timed out while waiting for response',
  ])('does not match unrelated errors: %s', (message) => {
    expect(isContextLengthExceededError(new Error(message))).toBe(false);
  });

  it('parses the DashScope input-range upper bound as the limit', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        '<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 196608]',
      ),
    );
    expect(info.isExceeded).toBe(true);
    expect(info.limitTokens).toBe(196608);
    expect(info.actualTokens).toBeUndefined();
    // The range bounds the prompt, not the window: `prompt + max_tokens` may
    // exceed it, so a consumer sizing an output budget against a window must
    // not use it (#13876).
    expect(info.limitKind).toBe('input');
  });

  // #13415: a local llama.cpp server names its REAL context ceiling in wording
  // none of the patterns above covered, so the reactive compaction path in
  // llm-chat never fired and the session looped on the same 400 forever.
  describe('llama.cpp context overflow wording (#13415)', () => {
    const LLAMA_CPP_OVERFLOW =
      'request (279935 tokens) exceeds the available context size (262144 tokens), try increasing it';

    it.each([
      // The raw server message.
      LLAMA_CPP_OVERFLOW,
      // The form the reporter actually saw: the CLI renders a caught request
      // failure as `[API Error: <status> <message>]`.
      `[API Error: 400 ${LLAMA_CPP_OVERFLOW}]`,
      // Same wording without the surrounding brackets.
      `API Error: 400 ${LLAMA_CPP_OVERFLOW}`,
    ])('detects overflow and parses both token counts: %s', (message) => {
      const info = getContextLengthExceededInfo(new Error(message));

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(279935);
      expect(info.limitTokens).toBe(262144);
      // "available context size" is the window itself, so the number may size
      // an output budget against it (#13432).
      expect(info.limitKind).toBe('total');
    });

    it('detects the wording nested in an SDK-style error object', () => {
      const info = getContextLengthExceededInfo({
        status: 400,
        error: { message: LLAMA_CPP_OVERFLOW },
      });

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(279935);
      expect(info.limitTokens).toBe(262144);
    });

    it('detects the wording through a wrapping cause chain', () => {
      const error = new Error('request failed', {
        cause: new Error(LLAMA_CPP_OVERFLOW),
      });

      const info = getContextLengthExceededInfo(error);

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(279935);
      expect(info.limitTokens).toBe(262144);
    });
  });

  it('parses prompt-too-long actual and limit token counts', () => {
    const info = getContextLengthExceededInfo(
      new Error('prompt is too long: 137500 tokens > 135000 maximum'),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBe(137500);
    expect(info.limitTokens).toBe(135000);
    // A bare `X tokens > M` does not say which quantity M bounds, so the kind
    // stays unset: consumers keep their previous behavior rather than treating
    // an unattested number as a window.
    expect(info.limitKind).toBeUndefined();
  });

  it('parses OpenAI-style maximum context length token counts', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens.",
      ),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBe(135000);
    expect(info.limitTokens).toBe(128000);
    expect(info.limitKind).toBe('total');
  });

  it('parses the input token count from vLLM wording', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        "This model's maximum context length is 16384 tokens. However, your prompt contains 25000 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt.",
      ),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBe(25000);
    expect(info.limitTokens).toBe(16384);
    expect(info.limitKind).toBe('total');
  });

  it('keeps vLLM "contains at least N" limit-only: the count is a tokenization cut-off', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        "This model's maximum context length is 16384 tokens. However, your prompt contains at least 16385 input tokens, which exceeds this limit even without any output tokens.",
      ),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBeUndefined();
    expect(info.limitTokens).toBe(16384);
    expect(info.limitKind).toBe('total');
  });

  it('marks an input token-count maximum as an input bound', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        'The input token length (127234) exceeds the maximum number of tokens allowed (100000).',
      ),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBe(127234);
    expect(info.limitTokens).toBe(100000);
    expect(info.limitKind).toBe('input');
  });

  it('parses maximum context length limits without actual token counts', () => {
    const info = getContextLengthExceededInfo(
      new Error("This model's maximum context length is 128000 tokens."),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBeUndefined();
    expect(info.limitTokens).toBe(128000);
  });

  it('extracts nested JSON error messages from strings', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        'HTTP 400 {"error":{"code":"context_length_exceeded","message":"prompt is too long: 137500 tokens > 135000 maximum"}}',
      ),
    );

    expect(info.isExceeded).toBe(true);
    expect(info.actualTokens).toBe(137500);
    expect(info.limitTokens).toBe(135000);
  });

  it('extracts nested error object messages', () => {
    const info = getContextLengthExceededInfo({
      status: 400,
      error: {
        code: 'BadRequest',
        message: 'Input token length is too long',
      },
    });

    expect(info.isExceeded).toBe(true);
    expect(info.message).toContain('Input token length is too long');
  });

  it('does not match object keys as context overflow text', () => {
    const info = getContextLengthExceededInfo({
      context: 'request body',
      detail: 'tokens are available',
      status: 'exceeded',
    });

    expect(info.isExceeded).toBe(false);
    expect(info.message).not.toContain('context');
    expect(info.message).toContain('tokens are available');
  });

  it('does not match broad token wording across separate fragments', () => {
    const info = getContextLengthExceededInfo({
      message: 'context window check',
      detail: 'tokens exceeded by policy wording',
    });

    expect(info.isExceeded).toBe(false);
  });

  it('skips accessor properties that throw while collecting error text', () => {
    const error = new Error('Connection error.');

    Object.defineProperty(error, 'name', {
      enumerable: true,
      get() {
        throw new TypeError('Value of "this" must be of DOMException');
      },
    });
    Object.defineProperty(error, 'details', {
      enumerable: true,
      get() {
        throw new TypeError('Value of "this" must be of DOMException');
      },
    });

    const info = getContextLengthExceededInfo(error);

    expect(info.isExceeded).toBe(false);
    expect(info.message).toContain('Connection error.');
  });

  it('skips throwing accessors on plain objects', () => {
    const errorLike: Record<string, unknown> = {};
    Object.defineProperty(errorLike, 'detail', {
      enumerable: true,
      get() {
        throw new TypeError('accessor refused');
      },
    });
    Object.defineProperty(errorLike, 'message', {
      enumerable: true,
      value: 'context_length_exceeded: too many tokens',
    });

    const info = getContextLengthExceededInfo(errorLike);

    expect(info.isExceeded).toBe(true);
    expect(info.message).toContain('context_length_exceeded');
  });

  // A timeout phrase vetoes the fragment it appears in, not the whole error.
  // Provider SDKs routinely attach retry/attempt metadata to an error, so a
  // sibling field mentioning an earlier timeout must not hide a real overflow.
  describe('timeout veto scope', () => {
    const OVERFLOW =
      "This model's maximum context length is 128000 tokens, however you requested 200000 tokens";

    it('still detects overflow when a sibling field mentions a timeout', () => {
      const error = Object.assign(new Error(OVERFLOW), {
        detail: 'previous attempt: request timed out after 60s',
      });

      const info = getContextLengthExceededInfo(error);

      expect(info.isExceeded).toBe(true);
      // The token counts must survive too: they are parsed only when the
      // error is classified as an overflow, so a veto silently lost them.
      expect(info.actualTokens).toBe(200000);
      expect(info.limitTokens).toBe(128000);
    });

    it('still detects overflow when retry metadata is nested deeper', () => {
      const error = Object.assign(new Error(OVERFLOW), {
        meta: {
          attempts: [
            { note: 'connection timed out while waiting for response' },
          ],
        },
      });

      expect(isContextLengthExceededError(error)).toBe(true);
    });

    it('does not treat a fragment that is itself a timeout as overflow', () => {
      // The guard against over-correcting: dropping the veto entirely would
      // also satisfy the two tests above. Here the timeout phrase and the
      // context-length phrase are in the SAME fragment, so the veto applies
      // and the error stays classified as a timeout.
      expect(
        isContextLengthExceededError(
          new Error('request timed out while checking maximum context length'),
        ),
      ).toBe(false);
    });
  });

  describe('prompt token count apart from the output budget (#9455)', () => {
    it.each([
      [
        'OpenAI, DeepSeek and older vLLM, with the completion broken out',
        "This model's maximum context length is 131072 tokens. However, you requested 131329 tokens (123137 in the messages, 8192 in the completion). Please reduce the length of the messages or completion.",
        123_137,
      ],
      [
        'OpenAI legacy completions',
        "This model's maximum context length is 4097 tokens, however you requested 5360 tokens (1360 in your prompt; 4000 for the completion). Please reduce your prompt; or completion length.",
        1_360,
      ],
      [
        'OpenRouter, an approximate total with the output broken out',
        "This endpoint's maximum context length is 262144 tokens. However, you requested about 300000 tokens (250000 of text input, 2000 of tool input, 48000 in the output). Please reduce the length of either one.",
        252_000,
      ],
      [
        'OpenAI, a prompt-only total',
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens (134000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions.",
        135_000,
      ],
      [
        'Anthropic',
        'prompt is too long: 210000 tokens > 200000 maximum',
        210_000,
      ],
      [
        'vLLM, prompt over the window with an output budget requested',
        "This model's maximum context length is 16384 tokens. However, you requested 2048 output tokens and your prompt contains 20000 input tokens, for a total of 22048 tokens. Please reduce the length of the input prompt or the number of requested output tokens.",
        20_000,
      ],
      [
        'vLLM, prompt alone over the window',
        "This model's maximum context length is 16384 tokens. However, your prompt contains 25000 input tokens, which exceeds this limit even without any output tokens.",
        25_000,
      ],
      [
        'vLLM, max_tokens too large for the prompt',
        "'max_tokens' or 'max_completion_tokens' is too large: 8000. This model's maximum context length is 16384 tokens and your request has 10000 input tokens (8000 > 16384 - 10000).",
        10_000,
      ],
      [
        'Gemini, older wording',
        'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).',
        1_196_265,
      ],
      [
        'llama.cpp',
        'request (279935 tokens) exceeds the available context size (262144 tokens), try increasing it',
        279_935,
      ],
      [
        'SGLang',
        "Requested token count exceeds the model's maximum context length of 32768 tokens. You requested a total of 40000 tokens: 36000 tokens from the input messages and 4000 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.",
        36_000,
      ],
    ])('reads the prompt count from %s', (_label, message, promptTokens) => {
      const info = getContextLengthExceededInfo(new Error(message));

      expect(info.isExceeded).toBe(true);
      expect(info.promptTokens).toBe(promptTokens);
      expect(info.requestedTokens).toBeUndefined();
    });

    it('reports a total that includes an unseparated output budget as requested, not as the prompt', () => {
      const info = getContextLengthExceededInfo(
        new Error(
          "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens. Please reduce the length of the messages or completion.",
        ),
      );

      expect(info.promptTokens).toBeUndefined();
      expect(info.requestedTokens).toBe(70_000);
    });

    it.each([
      [
        'a tokenization cut-off',
        "This model's maximum context length is 16384 tokens. However, your prompt contains at least 16385 input tokens.",
      ],
      [
        'a limit with no count',
        'The input token count exceeds the maximum number of tokens allowed 1048576.',
      ],
      ['a bare count comparison', 'Error: 70000 tokens > 65536 limit'],
      [
        'a requested output budget alone',
        "This model's maximum context length is 4096 tokens. However, you requested 1000000 tokens in the completion.",
      ],
    ])('reports no prompt count for %s', (_label, message) => {
      const info = getContextLengthExceededInfo(new Error(message));

      expect(info.isExceeded).toBe(true);
      expect(info.promptTokens).toBeUndefined();
      expect(info.requestedTokens).toBeUndefined();
    });

    it('does not pair a count from one fragment with the wording of another', () => {
      const body = JSON.stringify({
        error: {
          code: 400,
          message:
            'The input token count exceeds the maximum number of tokens allowed 1048576.',
          status: 'INVALID_ARGUMENT',
        },
      });

      const info = getContextLengthExceededInfo(body);

      expect(info.isExceeded).toBe(true);
      expect(info.promptTokens).toBeUndefined();
    });

    it('does not read a count that follows the wording only in another field', () => {
      // Joined, the two fields would read "prompt is too long:\n42 ...".
      const body = JSON.stringify({
        error: { message: 'prompt is too long:', detail: '42 requests queued' },
      });

      const info = getContextLengthExceededInfo(body);

      expect(info.isExceeded).toBe(true);
      expect(info.promptTokens).toBeUndefined();
    });

    it('leaves actualTokens as the reactive path has always read it', () => {
      const info = getContextLengthExceededInfo(
        new Error(
          "This model's maximum context length is 131072 tokens. However, you requested 131329 tokens (123137 in the messages, 8192 in the completion).",
        ),
      );

      expect(info.actualTokens).toBe(131_329);
      expect(info.promptTokens).toBe(123_137);
    });
  });
});
