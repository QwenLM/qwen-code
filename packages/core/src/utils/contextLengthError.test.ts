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
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

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

  // vLLM rejects an oversized prompt in its own words, so without these the
  // reactive compaction path never fired for self-hosted vLLM servers.
  describe('vLLM context overflow wording', () => {
    it.each([
      [
        'The decoder prompt (length 40000) is longer than the maximum model length of 32768. Make sure that `max_model_len` is no smaller than the number of text tokens.',
        40000,
      ],
      [
        'The decoder prompt (length 32768) plus the number of requested output tokens (at least 1) is longer than the maximum model length of 32768. Make sure that `max_model_len` is no smaller than the number of text tokens (prompt + requested output tokens).',
        32768,
      ],
      [
        'The engine prompt length 40000 exceeds the max_model_len 32768. Please reduce prompt.',
        40000,
      ],
    ])(
      'detects overflow and parses both token counts: %s',
      (message, actual) => {
        const info = getContextLengthExceededInfo(new Error(`400 ${message}`));

        expect(info.isExceeded).toBe(true);
        expect(info.actualTokens).toBe(actual);
        expect(info.limitTokens).toBe(32768);
        expect(info.limitKind).toBe('total');
      },
    );

    it('detects the wording nested in an SDK-style error object', () => {
      const info = getContextLengthExceededInfo({
        status: 400,
        error: {
          message:
            'The decoder prompt (length 40000) is longer than the maximum model length of 32768.',
        },
      });

      expect(info.isExceeded).toBe(true);
      expect(info.actualTokens).toBe(40000);
      expect(info.limitTokens).toBe(32768);
    });

    // An encoder prompt is not the chat history, so compacting the history
    // cannot fix it and the error is left for the user to see.
    it('leaves an encoder prompt overflow to the user', () => {
      const info = getContextLengthExceededInfo(
        new Error(
          '400 The encoder prompt (length 9000) is longer than the maximum model length of 8192.',
        ),
      );

      expect(info.isExceeded).toBe(false);
    });

    it('stays fast on a huge error body with repeated prompt fragments', () => {
      const body =
        "This model's maximum context length is exceeded. " +
        'The decoder prompt (length 1) '.repeat(20_000);
      const start = performance.now();

      const info = getContextLengthExceededInfo(new Error(body));

      expect(info.isExceeded).toBe(true);
      expectWithinLatencyBudget(performance.now() - start, 1_000, {
        poolMultiplier: 10,
      });
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
});
