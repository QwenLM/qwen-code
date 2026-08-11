/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import {
  isLocalIpcPath,
  isPeerSocketPath,
  MAX_SOCKET_PATH_BYTES,
  resolvePeerSocketPath,
} from './socket-path.js';

// `resolvePeerSocketPath` builds with `path.join`, so every expectation
// spelled with forward slashes is POSIX-only; `isLocalIpcPath` likewise
// swaps to a named-pipe rule on win32. The sibling `uds-inbox.test.ts`
// guards for the same reason.
const isWindows = process.platform === 'win32';

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
  it.skipIf(isWindows)('prefers XDG_RUNTIME_DIR', () => {
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';
    expect(resolvePeerSocketPath(4242)).toBe(
      '/run/user/1000/qwen-socks/4242.sock',
    );
  });

  // The tmpdir branch only survives when the resulting path still fits in
  // sun_path; past that `resolvePeerSocketPath` deliberately drops to /tmp,
  // so on a host with a long TMPDIR (deep self-hosted runner work dirs, Nix
  // sandboxes, devcontainers) this expectation would fail against correct
  // code. Skip rather than assert the wrong branch.
  const TMPDIR_SUFFIX_BYTES = Buffer.byteLength('/qwen-socks/4242.sock');
  it.skipIf(
    isWindows ||
      Buffer.byteLength(os.tmpdir()) + TMPDIR_SUFFIX_BYTES >
        MAX_SOCKET_PATH_BYTES,
  )('falls back to the system temp dir', () => {
    expect(resolvePeerSocketPath(4242)).toBe(
      `${os.tmpdir()}/qwen-socks/4242.sock`.replace(/\/+/g, '/'),
    );
  });

  it.skipIf(isWindows)(
    'falls back to a short /tmp path when the preferred one cannot be bound',
    () => {
      process.env['XDG_RUNTIME_DIR'] = `/run/${'d'.repeat(120)}`;
      const resolved = resolvePeerSocketPath(4242);
      expect(resolved).toMatch(/^\/tmp\/qwen-socks-\d+\/4242\.sock$/);
      expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(
        MAX_SOCKET_PATH_BYTES,
      );
    },
  );

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
  it.skipIf(isWindows)('accepts an absolute posix path', () => {
    expect(isLocalIpcPath('/run/user/1000/qwen-socks/1.sock')).toBe(true);
  });

  it.runIf(isWindows)('accepts a local named pipe on win32', () => {
    expect(isLocalIpcPath('\\\\.\\pipe\\qwen-socks-1')).toBe(true);
    expect(isLocalIpcPath('\\\\?\\pipe\\qwen-socks-1')).toBe(true);
    // Forward slashes are a legal spelling of the same local pipe.
    expect(isLocalIpcPath('//./pipe/qwen-socks-1')).toBe(true);
  });

  it.runIf(isWindows)('rejects a posix path on win32', () => {
    // It is not a pipe, so nothing on this platform can be listening there.
    expect(isLocalIpcPath('/run/user/1000/qwen-socks/1.sock')).toBe(false);
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

describe.skipIf(isWindows)('isPeerSocketPath', () => {
  it('accepts only numeric peer sockets at their managed path', () => {
    expect(isPeerSocketPath(resolvePeerSocketPath(42))).toBe(true);
    expect(isPeerSocketPath('/tmp/qwen-socks/not-a-pid.sock')).toBe(false);
    expect(isPeerSocketPath('/tmp/unrelated/42.sock')).toBe(false);
    expect(isPeerSocketPath('/tmp/unrelated/qwen-socks/42.sock')).toBe(false);
  });
});
