/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import {
  isLocalIpcPath,
  resolvePeerSocketCandidates,
  MAX_SOCKET_PATH_BYTES,
  resolvePeerSocketPath,
} from './socket-path.js';

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

// POSIX-only: the resolver builds paths with path.join and the
// expectations assume forward slashes; on Windows the whole feature is
// out of scope (see isLocalIpcPath), like the sibling socket suites.
describe.skipIf(isWindows)('resolvePeerSocketPath', () => {
  it('prefers XDG_RUNTIME_DIR', () => {
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';
    expect(resolvePeerSocketPath(4242)).toBe(
      '/run/user/1000/qwen-socks/4242.sock',
    );
  });

  it('falls back to an unpredictable per-session temp-dir path', () => {
    // A shared temp dir needs a random name: a fixed or uid-derived one
    // is a cross-user lockout or a pre-creatable DoS target.
    const tmpPrefix = `${os.tmpdir()}/`.replace(/\/+/g, '/');
    const first = resolvePeerSocketPath(4242).replace(/\/+/g, '/');
    const second = resolvePeerSocketPath(4242).replace(/\/+/g, '/');
    for (const resolved of [first, second]) {
      expect(resolved.startsWith(tmpPrefix)).toBe(true);
      expect(resolved).toMatch(/\/qwen-socks-[0-9a-f]{16}\/4242\.sock$/);
    }
    expect(first).not.toBe(second);
  });

  it('falls back to a short /tmp path when the preferred one cannot be bound', () => {
    process.env['XDG_RUNTIME_DIR'] = `/run/${'d'.repeat(120)}`;
    const originalTmpdir = process.env['TMPDIR'];
    process.env['TMPDIR'] = `/${'t'.repeat(110)}`;
    try {
      const resolved = resolvePeerSocketPath(4242);
      expect(resolved).toMatch(/^\/tmp\/qwen-socks-[0-9a-f]{16}\/4242\.sock$/);
      expect(Buffer.byteLength(resolved)).toBeLessThanOrEqual(
        MAX_SOCKET_PATH_BYTES,
      );
    } finally {
      if (originalTmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = originalTmpdir;
    }
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

/**
 * Set env vars for one test and put the real environment back afterwards.
 * Replacing `process.env` wholesale would leave the C-level environment
 * (which os.tmpdir() consults) carrying the test's values.
 */
function withEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('isLocalIpcPath', () => {
  it.skipIf(isWindows)('accepts an absolute posix path', () => {
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

describe('resolvePeerSocketCandidates', () => {
  it('lists the runtime directory first, then a nonce directory under tmpdir, then /tmp', () => {
    const restore = withEnv({
      XDG_RUNTIME_DIR: '/run/user/1000',
      TMPDIR: '/var/tmp',
    });
    try {
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates[0]).toBe('/run/user/1000/qwen-socks/42.sock');
      expect(candidates[1]).toMatch(
        /^\/var\/tmp\/qwen-socks-[0-9a-f]{16}\/42\.sock$/,
      );
      expect(candidates[2]).toMatch(
        /^\/tmp\/qwen-socks-[0-9a-f]{16}\/42\.sock$/,
      );
      // The same nonce for both fallbacks: one session, one directory name.
      expect(candidates[1]!.split('/')[3]).toBe(candidates[2]!.split('/')[2]);
    } finally {
      restore();
    }
  });

  it('drops candidates that cannot fit in sun_path', () => {
    const restore = withEnv({
      XDG_RUNTIME_DIR: '/' + 'r'.repeat(120),
      TMPDIR: undefined,
    });
    try {
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates.some((c) => c.startsWith('/rrr'))).toBe(false);
      expect(candidates.every((c) => Buffer.byteLength(c) <= 103)).toBe(true);
    } finally {
      restore();
    }
  });

  it('keeps one candidate even when nothing fits, so the failure can name it', () => {
    const restore = withEnv({
      XDG_RUNTIME_DIR: undefined,
      TMPDIR: '/' + 't'.repeat(200),
    });
    try {
      // /tmp/qwen-socks-<16hex>/<pid>.sock always fits; force a giant pid to
      // push even that over the limit is not possible, so check the shape.
      const candidates = resolvePeerSocketCandidates(42);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.at(-1)).toMatch(/^\/tmp\/qwen-socks-/);
    } finally {
      restore();
    }
  });
});
