/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getContextLengthExceededInfo,
  isContextLengthExceededError,
  statedContextWindows,
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
  describe('Hugging Face TGI context overflow wording', () => {
    it('parses the total-token wording with the inputs count as the prompt size', () => {
      const info = getContextLengthExceededInfo(
        new Error(
          '422 Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 40000 `inputs` tokens and 1000 `max_new_tokens`',
        ),
      );

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(40000);
      expect(info.limitTokens).toBe(32768);
      expect(info.limitKind).toBe('total');
    });

    it('parses the input-length wording as an input bound', () => {
      const info = getContextLengthExceededInfo(
        new Error(
          'Input validation error: `inputs` must have less than 32000 tokens. Given: 40000',
        ),
      );

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(40000);
      expect(info.limitTokens).toBe(32000);
      expect(info.limitKind).toBe('input');
    });

    it('detects the wording in an error body object', () => {
      const info = getContextLengthExceededInfo({
        status: 422,
        error: {
          error:
            'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4096. Given: 4000 `inputs` tokens and 200 `max_new_tokens`',
          error_type: 'validation',
        },
      });

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(4000);
      expect(info.limitTokens).toBe(4096);
    });

    it('does not match other TGI validation errors', () => {
      const info = getContextLengthExceededInfo(
        new Error(
          'Input validation error: `temperature` must be strictly positive',
        ),
      );

      expect(info.isExceeded).toBe(false);
    });
  });

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

  it('reads the window SGLang states as "maximum context length of N"', () => {
    const info = getContextLengthExceededInfo(
      new Error(
        "Requested token count exceeds the model's maximum context length of 32768 tokens. You requested a total of 40000 tokens: 36000 tokens from the input messages and 4000 tokens for the completion.",
      ),
    );

    expect(info.limitTokens).toBe(32_768);
    expect(info.limitKind).toBe('total');
  });

  describe('statedContextWindows', () => {
    const vllm = (window: number) =>
      `This model's maximum context length is ${window} tokens. However, your prompt contains 40000 input tokens.`;

    it.each([
      ['OpenAI and vLLM', vllm(32_768), [32_768]],
      [
        'SGLang',
        "Requested token count exceeds the model's maximum context length of 32768 tokens.",
        [32_768],
      ],
      [
        'llama.cpp',
        'request (279935 tokens) exceeds the available context size (262144 tokens), try increasing it',
        [262_144],
      ],
      [
        'TGI, the total',
        'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 40000 `inputs` tokens and 1000 `max_new_tokens`',
        [32_768],
      ],
    ])('reads the window %s states', (_label, message, windows) => {
      expect(statedContextWindows(new Error(message))).toEqual(windows);
    });

    it.each([
      // An untyped "N > M" may be a rate limit or a quota, not a window.
      [
        'an untyped comparison',
        'prompt is too long: 210000 tokens > 200000 maximum',
      ],
      // An input bound lets `prompt + max_tokens` exceed it; sizing a
      // request's window by it floors the summary budget (#13876).
      ['an input bound', 'Range of input length should be [1, 196608]'],
      ['no figure', 'context_length_exceeded'],
    ])('reads no window from %s', (_label, message) => {
      expect(statedContextWindows(new Error(message))).toEqual([]);
    });

    it('reads a window from each rejection the error carries', () => {
      // An earlier attempt's window is still one the same server stated; the
      // caller takes the smallest, so it can only shrink the request.
      const error = Object.assign(new Error(vllm(4_096)), {
        previousAttempt: { error: vllm(65_536) },
      });

      expect(statedContextWindows(error)).toEqual([4_096, 65_536]);
    });

    it.each([
      ['a rate-limit field', { quota: 'quota: 120 tokens > 60 per minute' }],
      [
        'a timeout field',
        {
          detail:
            'request timed out after 60s (maximum context length is 4096 tokens)',
        },
      ],
      [
        "another attempt's untyped comparison",
        {
          previousAttempt: 'prompt is too long: 310000 tokens > 300000 maximum',
        },
      ],
    ])('reads no window from %s beside the rejection', (_label, fields) => {
      const error = Object.assign(new Error(vllm(32_768)), fields);

      expect(statedContextWindows(error)).toEqual([32_768]);
    });

    it('reads nothing from an error that is not a context overflow', () => {
      expect(
        statedContextWindows(
          new Error('rate limit: 120 tokens > 60 per minute'),
        ),
      ).toEqual([]);
    });
  });
});
