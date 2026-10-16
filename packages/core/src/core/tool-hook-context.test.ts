/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import {
  appendToolHookContextToParts,
  boundToolHookContext,
  TOOL_HOOK_CONTEXT_TRUNCATION_NOTICE,
} from './tool-hook-context.js';

describe('boundToolHookContext', () => {
  it('joins non-empty segments in order', () => {
    expect(boundToolHookContext(['pre', undefined, '', 'fail'], 100)).toBe(
      'pre\n\nfail',
    );
  });

  it('returns undefined when there is nothing to deliver', () => {
    expect(boundToolHookContext([undefined, ''], 100)).toBeUndefined();
    expect(boundToolHookContext(['x'], 0)).toBeUndefined();
  });

  it('does not bound an unlimited threshold', () => {
    const long = 'a'.repeat(50_000);
    expect(boundToolHookContext([long], Number.POSITIVE_INFINITY)).toBe(long);
  });

  it('counts the truncation notice against the limit', () => {
    const result = boundToolHookContext(['a'.repeat(200)], 100)!;
    expect(result).toHaveLength(100);
    expect(result.endsWith(TOOL_HOOK_CONTEXT_TRUNCATION_NOTICE)).toBe(true);
  });

  it('shares the limit across segments', () => {
    const result = boundToolHookContext(['a'.repeat(80), 'b'.repeat(80)], 100)!;
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.startsWith('a'.repeat(63))).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const notice = TOOL_HOOK_CONTEXT_TRUNCATION_NOTICE.length;
    // Cut lands between the halves of the emoji.
    const text = 'a'.repeat(9) + '😀' + 'b'.repeat(50);
    const result = boundToolHookContext([text], 10 + notice)!;
    expect(result).toBe('a'.repeat(9) + TOOL_HOOK_CONTEXT_TRUNCATION_NOTICE);
    expect(result.length).toBeLessThanOrEqual(10 + notice);
  });

  it('returns a bare prefix when the limit cannot fit the notice', () => {
    expect(boundToolHookContext(['abcdefgh'], 4)).toBe('abcd');
  });
});

describe('appendToolHookContextToParts', () => {
  const fr = (id: string, response: Record<string, unknown>): Part => ({
    functionResponse: { id, name: 'tool', response },
  });

  it('returns the same array when there is no context', () => {
    const parts = [fr('c1', { output: 'ok' })];
    expect(appendToolHookContextToParts(parts, 'c1', undefined)).toBe(parts);
  });

  it('appends to the matching functionResponse output without mutating', () => {
    const media: Part = { inlineData: { mimeType: 'image/png', data: 'AA' } };
    const parts = [fr('other', { output: 'x' }), fr('c1', { output: 'ok' })];
    const withMedia = [...parts, media];
    const result = appendToolHookContextToParts(withMedia, 'c1', 'ctx');
    expect(result).not.toBe(withMedia);
    expect(result[0]).toBe(parts[0]);
    expect(result[1].functionResponse).toEqual({
      id: 'c1',
      name: 'tool',
      response: { output: 'ok\n\nctx' },
    });
    expect(result[2]).toBe(media);
    expect(parts[1].functionResponse!.response).toEqual({ output: 'ok' });
  });

  it('appends to the error text of an error response', () => {
    const [part] = appendToolHookContextToParts(
      [fr('c1', { error: 'boom' })],
      'c1',
      'ctx',
    );
    expect(part.functionResponse!.response).toEqual({ error: 'boom\n\nctx' });
  });

  it('serializes a structured output instead of emitting undefined', () => {
    const [part] = appendToolHookContextToParts(
      [fr('c1', { output: { a: 1 } })],
      'c1',
      'ctx',
    );
    expect(part.functionResponse!.response).toEqual({
      output: '{"a":1}\n\nctx',
    });
  });

  it('sets output when the response carries no text field', () => {
    const [part] = appendToolHookContextToParts([fr('c1', {})], 'c1', 'ctx');
    expect(part.functionResponse!.response).toEqual({ output: 'ctx' });
  });

  it('falls back to the only functionResponse when ids do not match', () => {
    const parts: Part[] = [
      { text: 'lead' },
      fr('provider-id', { output: 'o' }),
    ];
    const result = appendToolHookContextToParts(parts, 'c1', 'ctx');
    expect(result[1].functionResponse!.response).toEqual({
      output: 'o\n\nctx',
    });
  });

  it('leaves ambiguous parts unchanged', () => {
    const parts = [fr('a', { output: 'x' }), fr('b', { output: 'y' })];
    expect(appendToolHookContextToParts(parts, 'c1', 'ctx')).toBe(parts);
    const textOnly: Part[] = [{ text: 'x' }];
    expect(appendToolHookContextToParts(textOnly, 'c1', 'ctx')).toBe(textOnly);
  });
});
