/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { defaultModalities } from './modalityDefaults.js';
import { tokenLimit } from './tokenLimits.js';

// Gateways and cloud platforms expose the same model under their own id
// shape: a provider path (`azure/`, `vertex_ai/`, `openrouter/`,
// `accounts/<org>/models/`) or an auth-type prefix (`openai:`). Each id below
// must resolve to the limits and input modalities of the bare model id, or
// the session silently runs with the default 200K window and text-only input.
// A Vertex AI `@version` pin is tolerated only where the family row is a
// prefix match: `normalize()` does not strip it.
const GATEWAY_ID_SHAPES: Array<[shaped: string, bare: string]> = [
  ['azure/gpt-4o', 'gpt-4o'],
  ['openai:gpt-4o', 'gpt-4o'],
  ['models/gemini-2.5-pro', 'gemini-2.5-pro'],
  ['vertex_ai/gemini-2.5-flash', 'gemini-2.5-flash'],
  ['vertex_ai/claude-sonnet-4-5@20250929', 'claude-sonnet-4-5'],
  ['claude-opus-4-6@20260101', 'claude-opus-4-6'],
  ['openrouter/anthropic/claude-sonnet-4.5', 'claude-sonnet-4-5'],
  // A dotted Opus alias that collapsed to `claude-opus` would drop from 1M to
  // the generic 200K, so this row fails if the dotted rewrite breaks.
  ['openrouter/anthropic/claude-opus-4.8', 'claude-opus-4-8'],
  [
    'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct',
    'qwen3-coder-480b-a35b-instruct',
  ],
  [
    'together_ai/Qwen/Qwen3-Coder-480B-A35B-Instruct',
    'qwen3-coder-480b-a35b-instruct',
  ],
  ['dashscope/qwen3-coder-plus', 'qwen3-coder-plus'],
  ['deepinfra/deepseek-ai/DeepSeek-V4-Flash', 'deepseek-v4-flash'],
];

describe('gateway and cloud model id shapes', () => {
  it.each(GATEWAY_ID_SHAPES)('%s resolves like %s', (shaped, bare) => {
    expect(tokenLimit(shaped)).toBe(tokenLimit(bare));
    expect(tokenLimit(shaped, 'output')).toBe(tokenLimit(bare, 'output'));
    expect(defaultModalities(shaped)).toEqual(defaultModalities(bare));
  });

  it('keeps the real limits rather than the default fallback', () => {
    // Pinned absolutely too: if both sides of a pair fell back to the
    // default they would still match each other.
    expect(tokenLimit('claude-opus-4-6@20260101')).toBe(1_000_000);
    expect(tokenLimit('claude-opus-4-6@20260101', 'output')).toBe(128_000);
    expect(defaultModalities('vertex_ai/claude-sonnet-4-5@20250929')).toEqual(
      expect.objectContaining({ image: true }),
    );
  });
});
