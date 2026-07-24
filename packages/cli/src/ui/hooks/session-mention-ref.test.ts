/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseSessionRef,
  buildSessionRef,
  isSessionId,
  SESSION_MENTION_PREFIX,
} from './session-mention-ref.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('sessionMentionRef', () => {
  it('returns null for non-session tokens', () => {
    expect(parseSessionRef('file.txt')).toBeNull();
    expect(parseSessionRef('ext:foo')).toBeNull();
  });

  it('parses a UUID remainder as an id', () => {
    expect(parseSessionRef(`${SESSION_MENTION_PREFIX}${UUID}`)).toEqual({
      id: UUID,
    });
  });

  it('parses a non-UUID remainder as a title', () => {
    expect(parseSessionRef('session:Fix auth bug')).toEqual({
      title: 'Fix auth bug',
    });
  });

  it('treats an empty remainder as null (lone prefix)', () => {
    expect(parseSessionRef('session:')).toBeNull();
  });

  it('builds a ref without a leading @', () => {
    expect(buildSessionRef(UUID)).toBe(`session:${UUID}`);
  });

  it('recognizes UUIDs', () => {
    expect(isSessionId(UUID)).toBe(true);
    expect(isSessionId('not-a-uuid')).toBe(false);
  });
});
