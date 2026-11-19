/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ loadAddon: vi.fn(), spawn: vi.fn() }));
vi.mock('./runtime-info.js', () => ({ isBunRuntime: () => true }));
vi.mock('./bun-pty.js', () => backend);

afterEach(() => vi.restoreAllMocks());

it.each([
  ['MODULE_NOT_FOUND', "Cannot find module '@lydell/node-pty-linux-x64'"],
  ['ERR_DLOPEN_FAILED', 'native module failed to dlopen: pty.node'],
])(
  'declines an unusable Bun backend (%s) before spawning',
  async (code, message) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    backend.loadAddon.mockReset().mockImplementation(() => {
      throw Object.assign(new Error(message), { code });
    });
    backend.spawn.mockClear();
    try {
      const { loadPty, getPty } = await import('./getPty.js');
      const result = await loadPty();
      expect(result.impl === null).toBe(true);
      expect(result.loadError).toBe(message);
      expect((await getPty()) === null).toBe(true);
      expect(backend.loadAddon).toHaveBeenCalledTimes(2);
      expect(backend.spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  },
);
