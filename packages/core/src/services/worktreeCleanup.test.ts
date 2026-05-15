/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from './worktreeCleanup.js';

const { isEphemeralSlug } = __test__;

describe('isEphemeralSlug', () => {
  it('matches the agent-<7hex> pattern', () => {
    expect(isEphemeralSlug('agent-aabbccd')).toBe(true);
    expect(isEphemeralSlug('agent-0000000')).toBe(true);
    expect(isEphemeralSlug('agent-abcdef0')).toBe(true);
  });

  it('rejects non-matching shapes', () => {
    expect(isEphemeralSlug('agent-')).toBe(false);
    expect(isEphemeralSlug('agent-toolong0')).toBe(false);
    expect(isEphemeralSlug('agent-abcdefg')).toBe(false); // g is not hex
    expect(isEphemeralSlug('AGENT-aabbccd')).toBe(false); // uppercase
    expect(isEphemeralSlug('my-feature')).toBe(false);
    expect(isEphemeralSlug('')).toBe(false);
  });

  it('does not sweep user-named worktrees that share the prefix', () => {
    expect(isEphemeralSlug('agent-feature')).toBe(false);
    expect(isEphemeralSlug('agentic')).toBe(false);
    expect(isEphemeralSlug('my-agent-aabbccd')).toBe(false);
  });
});
