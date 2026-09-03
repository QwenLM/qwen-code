/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServeOptions } from './types.js';
import { applyOpenWithAuth } from './open-with-auth.js';

const mockResolveWebShellDir = vi.hoisted(() =>
  vi.fn<() => string | undefined>(() => '/tmp/web-shell'),
);

vi.mock('./web-shell-resolver.js', () => ({
  resolveWebShellDir: mockResolveWebShellDir,
}));

function options(overrides: Partial<ServeOptions> = {}): ServeOptions {
  return {
    hostname: '127.0.0.1',
    mode: 'http-bridge',
    port: 4170,
    ...overrides,
  };
}

const originalServerToken = process.env['QWEN_SERVER_TOKEN'];

describe('applyOpenWithAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveWebShellDir.mockReturnValue('/tmp/web-shell');
    delete process.env['QWEN_SERVER_TOKEN'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalServerToken === undefined) {
      delete process.env['QWEN_SERVER_TOKEN'];
    } else {
      process.env['QWEN_SERVER_TOKEN'] = originalServerToken;
    }
  });

  it('generates a 256-bit base64url token without mutating the environment', () => {
    const serveOptions = options();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    applyOpenWithAuth(serveOptions);
    expect(serveOptions.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(serveOptions.token!, 'base64url')).toHaveLength(32);
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(stderrWrites.join('')).toContain(
      'temporary bearer authentication enabled',
    );
    expect(stderrWrites.join('')).not.toContain(serveOptions.token);
  });

  it('preserves an explicit option token over the environment', () => {
    process.env['QWEN_SERVER_TOKEN'] = 'env-token';
    const serveOptions = options({ token: ' option-token ' });

    applyOpenWithAuth(serveOptions);

    expect(serveOptions.token).toBe('option-token');
  });

  it('preserves an environment token when no option is set', () => {
    process.env['QWEN_SERVER_TOKEN'] = ' env-token ';
    const serveOptions = options();

    applyOpenWithAuth(serveOptions);

    expect(serveOptions.token).toBe('env-token');
  });

  it('treats an explicitly whitespace-only option as absent after it shadows the environment', () => {
    process.env['QWEN_SERVER_TOKEN'] = 'env-token';
    const serveOptions = options({ token: '  ' });

    applyOpenWithAuth(serveOptions);

    expect(serveOptions.token).not.toBe('env-token');
    expect(serveOptions.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    [
      options({ hostname: '0.0.0.0' }),
      '--open-with-auth requires a loopback --hostname.',
    ],
    [
      options({ serveWebShell: false }),
      '--open-with-auth requires the Web Shell; omit --no-web.',
    ],
  ])('rejects an ineligible invocation', (serveOptions, message) => {
    expect(() => applyOpenWithAuth(serveOptions)).toThrow(message);
  });

  it('requires built Web Shell assets', () => {
    mockResolveWebShellDir.mockReturnValue(undefined);

    expect(() => applyOpenWithAuth(options())).toThrow(
      '--open-with-auth requires built Web Shell assets.',
    );
  });

  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '::1', '[::1]'])(
    'accepts the existing loopback bind %s',
    (hostname) => {
      const serveOptions = options({ hostname });
      applyOpenWithAuth(serveOptions);
      expect(serveOptions.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    },
  );

  it('rejects non-loopback even when a token is already configured', () => {
    expect(() =>
      applyOpenWithAuth(
        options({ hostname: '192.168.1.2', token: 'configured' }),
      ),
    ).toThrow('--open-with-auth requires a loopback --hostname.');
  });
});
