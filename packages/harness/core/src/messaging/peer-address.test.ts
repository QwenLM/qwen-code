/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  hopChainContains,
  hopIdForAddress,
  isLocalIpcPath,
  isValidPeerAddress,
  parsePeerAddress,
  toUdsAddress,
} from './peer-address.js';

describe('peer address', () => {
  it('round-trips an ordinary socket path', () => {
    const socketPath = '/tmp/test-socks/1234.sock';
    const address = toUdsAddress(socketPath);
    expect(address).toBe('uds:/tmp/test-socks/1234.sock');
    expect(parsePeerAddress(address)).toEqual({
      scheme: 'uds',
      target: socketPath,
    });
  });

  it('round-trips a path containing spaces', () => {
    const socketPath = '/tmp/my sockets/1.sock';
    const address = toUdsAddress(socketPath);
    expect(address).not.toContain(' ');
    expect(parsePeerAddress(address).target).toBe(socketPath);
    expect(isValidPeerAddress(address)).toBe(true);
  });

  it('treats a bare absolute path as a uds address', () => {
    expect(parsePeerAddress('/tmp/a.sock')).toEqual({
      scheme: 'uds',
      target: '/tmp/a.sock',
    });
  });

  it('classifies anything else as other', () => {
    expect(parsePeerAddress('bridge:abc').scheme).toBe('other');
  });

  it('rejects over-long and malformed addresses', () => {
    expect(isValidPeerAddress('')).toBe(false);
    expect(isValidPeerAddress(`uds:${'a'.repeat(400)}`)).toBe(false);
    expect(isValidPeerAddress('uds:/tmp/a b.sock')).toBe(false);
  });

  describe('isLocalIpcPath', () => {
    it('accepts an absolute path', () => {
      expect(isLocalIpcPath('/tmp/a.sock')).toBe(true);
    });

    it('rejects a relative path, a URL and a NUL byte', () => {
      expect(isLocalIpcPath('tmp/a.sock')).toBe(false);
      expect(isLocalIpcPath('http://example.com/a')).toBe(false);
      expect(isLocalIpcPath('/tmp/a\0.sock')).toBe(false);
      expect(isLocalIpcPath('')).toBe(false);
    });
  });

  describe('hop chain', () => {
    it('derives a stable 24-hex id', () => {
      const id = hopIdForAddress('uds:/tmp/a.sock');
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      expect(hopIdForAddress('uds:/tmp/a.sock')).toBe(id);
      expect(hopIdForAddress('uds:/tmp/b.sock')).not.toBe(id);
    });

    it('detects a hop in a chain', () => {
      const first = hopIdForAddress('uds:/tmp/a.sock');
      expect(hopChainContains([first], first)).toBe(true);
      expect(hopChainContains([first], hopIdForAddress('uds:/tmp/b.sock'))).toBe(
        false,
      );
      expect(hopChainContains(undefined, first)).toBe(false);
    });
  });
});
