/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isPreSpawnRefusal,
  markPreSpawnRefusal,
  preSpawnRefusal,
} from './sub-session-refusal.js';

class BridgeError extends Error {}

describe('pre-spawn refusals', () => {
  it('marks a refusal the launcher raises itself', () => {
    const error = preSpawnRefusal('Too many concurrent sub-sessions');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Too many concurrent sub-sessions');
    expect(isPreSpawnRefusal(error)).toBe(true);
  });

  it('marks someone else’s error without replacing it', () => {
    // The bridge's SessionNotFoundError must stay matchable by type: callers
    // that branch on it cannot be broken by the classification.
    const original = new BridgeError('session not found');
    const returned = markPreSpawnRefusal(original);
    expect(returned).toBe(original);
    expect(returned).toBeInstanceOf(BridgeError);
    expect(isPreSpawnRefusal(returned)).toBe(true);
  });

  it('does not classify an unmarked failure, however it reads', () => {
    // A post-spawn failure may already have published a report. The message is
    // not evidence; only the marker is.
    expect(
      isPreSpawnRefusal(new Error('Too many concurrent sub-sessions')),
    ).toBe(false);
    expect(isPreSpawnRefusal(new BridgeError('spawn failed'))).toBe(false);
  });

  it('tolerates a non-object throw', () => {
    expect(isPreSpawnRefusal(undefined)).toBe(false);
    expect(isPreSpawnRefusal(null)).toBe(false);
    expect(isPreSpawnRefusal('a string')).toBe(false);
    expect(markPreSpawnRefusal('a string')).toBe('a string');
  });

  it('does not leak the marker into JSON or across errors', () => {
    const marked = preSpawnRefusal('cap');
    const plain = new Error('cap');
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
    expect(isPreSpawnRefusal(plain)).toBe(false);
  });
});
