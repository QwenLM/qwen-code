/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServeOptions } from './types.js';
import { applyOpenEphemeralAuth } from './open-ephemeral-auth.js';

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

describe('applyOpenEphemeralAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveWebShellDir.mockReturnValue('/tmp/web-shell');
  });

  it('generates a 256-bit base64url token without mutating the environment', () => {
    const serveOptions = options();
    const env: Record<string, string | undefined> = {};
    const before = { ...env };
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    expect(applyOpenEphemeralAuth(serveOptions, true, true, env)).toBe(true);
    expect(serveOptions.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(serveOptions.token!, 'base64url')).toHaveLength(32);
    expect(env).toEqual(before);
    expect(stderrWrites.join('')).toContain(
      'temporary bearer authentication enabled',
    );
    expect(stderrWrites.join('')).not.toContain(serveOptions.token);
  });

  it('preserves an explicit option token over the environment', () => {
    const serveOptions = options({ token: ' option-token ' });

    expect(
      applyOpenEphemeralAuth(serveOptions, true, true, {
        QWEN_SERVER_TOKEN: 'env-token',
      }),
    ).toBe(false);
    expect(serveOptions.token).toBe(' option-token ');
  });

  it('preserves an environment token when no option is set', () => {
    const serveOptions = options();

    expect(
      applyOpenEphemeralAuth(serveOptions, true, true, {
        QWEN_SERVER_TOKEN: 'env-token',
      }),
    ).toBe(false);
    expect(serveOptions.token).toBeUndefined();
  });

  it('treats an explicitly whitespace-only option as absent after it shadows the environment', () => {
    const serveOptions = options({ token: '  ' });

    expect(
      applyOpenEphemeralAuth(serveOptions, true, true, {
        QWEN_SERVER_TOKEN: 'env-token',
      }),
    ).toBe(true);
    expect(serveOptions.token).not.toBe('env-token');
  });

  it.each([
    [options(), false, '--ephemeral-auth requires --open.'],
    [
      options({ hostname: '0.0.0.0' }),
      true,
      '--ephemeral-auth requires a loopback --hostname.',
    ],
    [
      options({ serveWebShell: false }),
      true,
      '--ephemeral-auth requires the Web Shell; omit --no-web.',
    ],
  ])('rejects an ineligible invocation', (serveOptions, open, message) => {
    expect(() => applyOpenEphemeralAuth(serveOptions, open, true, {})).toThrow(
      message,
    );
  });

  it('requires built Web Shell assets', () => {
    mockResolveWebShellDir.mockReturnValue(undefined);

    expect(() => applyOpenEphemeralAuth(options(), true, true, {})).toThrow(
      '--ephemeral-auth requires built Web Shell assets.',
    );
  });

  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '::1', '[::1]'])(
    'accepts the existing loopback bind %s',
    (hostname) => {
      expect(
        applyOpenEphemeralAuth(options({ hostname }), true, true, {}),
      ).toBe(true);
    },
  );

  it('rejects non-loopback even when a token is already configured', () => {
    expect(() =>
      applyOpenEphemeralAuth(
        options({ hostname: '192.168.1.2', token: 'configured' }),
        true,
        true,
        {},
      ),
    ).toThrow('--ephemeral-auth requires a loopback --hostname.');
  });

  it('is a no-op when the flag is disabled', () => {
    const serveOptions = options({ hostname: '0.0.0.0' });

    expect(applyOpenEphemeralAuth(serveOptions, false, false, {})).toBe(false);
    expect(serveOptions.token).toBeUndefined();
  });
});
