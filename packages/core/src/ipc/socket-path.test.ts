/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import {
  isLocalIpcPath,
  MAX_SOCKET_PATH_BYTES,
  resolvePeerSocketPath,
} from './socket-path.js';

const originalRuntimeDir = process.env['XDG_RUNTIME_DIR'];

beforeEach(() => {
  delete process.env['XDG_RUNTIME_DIR'];
});

afterEach(() => {
  if (originalRuntimeDir === undefined) {
    delete process.env['XDG_RUNTIME_DIR'];
  } else {
    process.env['XDG_RUNTIME_DIR'] = originalRuntimeDir;
  }
});

describe('resolvePeerSocketPath', () => {
  it('prefers XDG_RUNTIME_DIR', () => {
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';
    expect(resolvePeerSocketPath(4242)).toBe(
      '/run/user/1000/qwen-socks/4242.sock',
    );
  });

  it('falls back to the system temp dir', () => {
    expect(resolvePeerSocketPath(4242)).toBe(
      `${os.tmpdir()}/qwen-socks/4242.sock`.replace(/\/+/g, '/'),
    );
  });

  it('falls back to a short /tmp path when the preferred one cannot be bound', () => {
    process.env['XDG_RUNTIME_DIR'] = `/run/${'d'.repeat(120)}`;
    const resolved = resolvePeerSocketPath(4242);
    expect(resolved).toMatch(/^\/tmp\/qwen-socks-\d+\/4242\.sock$/);
    expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(
      MAX_SOCKET_PATH_BYTES,
    );
  });

  it('keeps a path that is exactly at the limit', () => {
    // Build a runtime dir that lands the full path on the boundary.
    const suffix = '/qwen-socks/4242.sock';
    const dirLength = MAX_SOCKET_PATH_BYTES - suffix.length;
    process.env['XDG_RUNTIME_DIR'] = '/' + 'd'.repeat(dirLength - 1);
    const resolved = resolvePeerSocketPath(4242);
    expect(Buffer.byteLength(resolved)).toBe(MAX_SOCKET_PATH_BYTES);
    expect(resolved.startsWith('/tmp/qwen-socks-')).toBe(false);
  });
});

describe('isLocalIpcPath', () => {
  it('accepts an absolute posix path', () => {
    expect(isLocalIpcPath('/run/user/1000/qwen-socks/1.sock')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isLocalIpcPath('qwen-socks/1.sock')).toBe(false);
    expect(isLocalIpcPath('./1.sock')).toBe(false);
    expect(isLocalIpcPath('../../etc/1.sock')).toBe(false);
  });

  it('rejects UNC-looking paths that could dial another host', () => {
    expect(isLocalIpcPath('//server/pipe/qwen')).toBe(false);
  });

  it('rejects a path containing a NUL', () => {
    expect(isLocalIpcPath('/tmp/a\0/../../etc/passwd')).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(isLocalIpcPath('')).toBe(false);
    expect(isLocalIpcPath(undefined as unknown as string)).toBe(false);
    expect(isLocalIpcPath(42 as unknown as string)).toBe(false);
  });
});
