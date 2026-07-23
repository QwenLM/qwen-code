/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { loadPolicy, PolicyError } from './loader.js';

const withMax = (body: string) =>
  `rules:\n  - id: a\n    match: { tool: execute }\n    action: allow\n    maxPerWindow: ${body}\n`;

describe('loadPolicy maxPerWindow validation (cycle 43)', () => {
  it('parses a valid { count, windowSec } into the typed shape', () => {
    const p = loadPolicy(withMax('{ count: 5, windowSec: 60 }'));
    expect(p.rules[0].maxPerWindow).toEqual({ count: 5, windowSec: 60 });
  });

  it('allows count: 0 (a non-negative integer)', () => {
    const p = loadPolicy(withMax('{ count: 0, windowSec: 1 }'));
    expect(p.rules[0].maxPerWindow).toEqual({ count: 0, windowSec: 1 });
  });

  it('ignores unknown sub-keys (forward-compat)', () => {
    const p = loadPolicy(withMax('{ count: 2, windowSec: 30, soft: true }'));
    expect(p.rules[0].maxPerWindow).toEqual({ count: 2, windowSec: 30 });
  });

  it('rejects a non-mapping maxPerWindow', () => {
    expect(() => loadPolicy(withMax('5'))).toThrow(PolicyError);
    expect(() => loadPolicy(withMax('5'))).toThrow(/must be a mapping/);
  });

  it('rejects a negative count', () => {
    expect(() => loadPolicy(withMax('{ count: -1, windowSec: 60 }'))).toThrow(
      /count must be a non-negative integer/,
    );
  });

  it('rejects a non-integer count', () => {
    expect(() => loadPolicy(withMax('{ count: 1.5, windowSec: 60 }'))).toThrow(
      /count must be a non-negative integer/,
    );
  });

  it('rejects windowSec: 0 and negative windowSec', () => {
    expect(() => loadPolicy(withMax('{ count: 5, windowSec: 0 }'))).toThrow(
      /windowSec must be a positive integer/,
    );
    expect(() => loadPolicy(withMax('{ count: 5, windowSec: -1 }'))).toThrow(
      /windowSec must be a positive integer/,
    );
  });

  it('rejects a non-integer windowSec', () => {
    expect(() => loadPolicy(withMax('{ count: 5, windowSec: 2.5 }'))).toThrow(
      /windowSec must be a positive integer/,
    );
  });

  it('rejects a missing count or windowSec', () => {
    expect(() => loadPolicy(withMax('{ windowSec: 60 }'))).toThrow(PolicyError);
    expect(() => loadPolicy(withMax('{ count: 5 }'))).toThrow(PolicyError);
  });

  it('rejects duplicate rule ids (ambiguous audit/quota key)', () => {
    const yaml = `rules:\n  - id: dup\n    match: { tool: execute }\n    action: allow\n  - id: dup\n    match: { tool: read }\n    action: deny\n`;
    expect(() => loadPolicy(yaml)).toThrow(/duplicate rule id: dup/);
  });

  it('allows multiple id-less rules (only ids must be unique)', () => {
    const yaml = `rules:\n  - match: { tool: execute }\n    action: allow\n  - match: { tool: read }\n    action: deny\n`;
    expect(loadPolicy(yaml).rules).toHaveLength(2);
  });
});
