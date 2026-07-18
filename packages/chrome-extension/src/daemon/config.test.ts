/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DAEMON_BASE_URL,
  getDaemonConfig,
  isLoopbackUrl,
} from './config.js';

const storageGet = vi.fn();
const storageSet = vi.fn();
let consoleWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  storageGet.mockReset();
  storageSet.mockReset();
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
  } as unknown as typeof chrome;
});

afterEach(() => {
  consoleWarn.mockRestore();
});

describe('daemon config', () => {
  it.each([
    ['http://127.0.0.1:4170', true],
    ['http://localhost:4170', true],
    ['http://[::1]:4170', true],
    ['http://127.0.0.1.evil.com:4170', false],
    ['http://localhost.evil.com:4170', false],
    ['not a url', false],
  ])('classifies loopback URL %s as %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });

  it('falls back to the default daemon config for remote stored URLs', async () => {
    storageGet.mockResolvedValue({
      'qwen.daemon': {
        baseUrl: 'https://attacker.example.com',
        token: 'secret',
      },
    });

    await expect(getDaemonConfig()).resolves.toEqual({
      baseUrl: DEFAULT_DAEMON_BASE_URL,
      token: undefined,
    });
    expect(consoleWarn).toHaveBeenCalledWith(
      '[DaemonConfig] ignoring non-loopback baseUrl:',
      'https://attacker.example.com',
    );
  });

  it('trims loopback base URL and token from storage', async () => {
    storageGet.mockResolvedValue({
      'qwen.daemon': {
        baseUrl: ' http://localhost:4170 ',
        token: ' token ',
      },
    });

    await expect(getDaemonConfig()).resolves.toEqual({
      baseUrl: 'http://localhost:4170',
      token: 'token',
    });
  });
});
