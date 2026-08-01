/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
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

  it('preserves the already-normalized title passed by the command parser', () => {
    expect(parseSessionRef('session:My Chat')).toEqual({ title: 'My Chat' });
  });

  it('unescapes Windows session titles exactly once', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      expect(parseSessionRef('session:a\\&b')).toEqual({ title: 'a&b' });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not unescape an already-normalized POSIX title again', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux');
    try {
      expect(parseSessionRef('session:a\\&b')).toEqual({ title: 'a\\&b' });
    } finally {
      platformSpy.mockRestore();
    }
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
