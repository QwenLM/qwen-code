/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { matchMcpServerPrefix } from './mcpResourceRef.js';

describe('matchMcpServerPrefix', () => {
  it('matches a configured server name prefix and returns the remainder', () => {
    expect(
      matchMcpServerPrefix('demo:res://welcome', new Set(['demo'])),
    ).toEqual({ serverName: 'demo', rest: 'res://welcome' });
  });

  it('returns null when no configured server prefixes the input', () => {
    expect(matchMcpServerPrefix('other:thing', new Set(['demo']))).toBeNull();
    // A bare path with no ':' never matches.
    expect(matchMcpServerPrefix('path/to/file', new Set(['demo']))).toBeNull();
  });

  it('picks the LONGEST matching server name (handles colons in names)', () => {
    expect(
      matchMcpServerPrefix('my:server:res://x', new Set(['my', 'my:server'])),
    ).toEqual({ serverName: 'my:server', rest: 'res://x' });
  });

  it('returns an empty remainder for a bare `server:` trigger', () => {
    expect(matchMcpServerPrefix('demo:', new Set(['demo']))).toEqual({
      serverName: 'demo',
      rest: '',
    });
  });

  it('never matches inherited object keys', () => {
    // `Object.keys({})` is empty, so prototype keys are not iterated.
    expect(
      matchMcpServerPrefix('__proto__:x', new Set(Object.keys({}))),
    ).toBeNull();
  });
});
