/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('WINDOWS_TASKKILL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const resolve = async (systemRoot: string | undefined): Promise<string> => {
    vi.resetModules();
    if (systemRoot === undefined) {
      vi.stubEnv('SystemRoot', '');
    } else {
      vi.stubEnv('SystemRoot', systemRoot);
    }
    return (await import('./windowsTaskkill.js')).WINDOWS_TASKKILL;
  };

  it('uses an absolute SystemRoot drive path', async () => {
    expect(await resolve('D:\\WINNT')).toBe(
      'D:\\WINNT\\System32\\taskkill.exe',
    );
  });

  it('accepts a forward-slash drive path', async () => {
    expect(await resolve('C:/Windows')).toBe(
      'C:/Windows\\System32\\taskkill.exe',
    );
  });

  it('falls back when SystemRoot is relative (poisoned)', async () => {
    // A relative value would otherwise make the resolved path relative and
    // re-open CWD resolution — the binary-planting vector. See #5873.
    expect(await resolve('Windows')).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    );
    expect(await resolve('..\\..\\evil')).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    );
  });

  it('falls back when SystemRoot is unset', async () => {
    expect(await resolve(undefined)).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    );
  });

  it('is always an absolute, never a bare, executable path', async () => {
    for (const sr of ['C:\\Windows', 'Windows', '', 'taskkill', '..\\x']) {
      const p = await resolve(sr);
      expect(/^[A-Za-z]:[\\/]/.test(p)).toBe(true);
      expect(p.endsWith('\\System32\\taskkill.exe')).toBe(true);
      expect(p).not.toBe('taskkill');
    }
  });
});
