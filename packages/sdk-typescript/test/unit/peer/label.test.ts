/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  boundSessionName,
  deriveSessionName,
  flattenPeerLabel,
  MAX_LABEL_CHARS,
  MAX_SESSION_NAME_CHARS,
  peerRef,
} from '../../../src/peer/label.js';

describe('labels', () => {
  it('flattens control, format and bidirectional characters to one line', () => {
    expect(flattenPeerLabel('  voice\n\tbridge\u202e\u200b ')).toBe(
      'voice bridge',
    );
  });

  it('caps a flattened label with an ellipsis', () => {
    const flattened = flattenPeerLabel('x'.repeat(500));
    expect(flattened).toHaveLength(MAX_LABEL_CHARS);
    expect(flattened.endsWith('…')).toBe(true);
  });

  it('bounds a record name in code points, never splitting a surrogate pair', () => {
    const name = boundSessionName('\u{1F600}'.repeat(60));
    const points = Array.from(name);
    expect(points).toHaveLength(MAX_SESSION_NAME_CHARS);
    expect(points.at(-2)).toBe('\u{1F600}');
    expect(boundSessionName(' \n ')).toBe('');
  });

  it('derives a stable six-character ref from the session id', () => {
    expect(peerRef('abc')).toMatch(/^[0-9a-f]{6}$/);
    expect(peerRef('abc')).toBe(peerRef('abc'));
    expect(peerRef('abc')).not.toBe(peerRef('abd'));
  });

  it('derives a default name from the directory and the session id', () => {
    expect(deriveSessionName('/home/me/my project!', 'id')).toMatch(
      /^my-project-[0-9a-f]{2}$/,
    );
    expect(deriveSessionName('/', 'id')).toMatch(/^session-[0-9a-f]{2}$/);
  });
});
