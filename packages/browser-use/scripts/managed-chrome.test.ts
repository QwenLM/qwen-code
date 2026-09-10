/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchManagedChrome } from './managed-chrome.js';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  executablePath: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: mocks.access,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}));

vi.mock('playwright-core', () => ({
  chromium: { executablePath: mocks.executablePath },
}));

describe('managed Chrome discovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('QWEN_BROWSER_USE_CHROME', '');
    mocks.executablePath.mockReturnValue('/missing/playwright/chrome');
    mocks.access.mockRejectedValue(new Error('ENOENT'));
    mocks.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error) => void,
      ) => callback(new Error('Stopped at browser version probe')),
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  async function expectSelectedBrowser(path: string): Promise<void> {
    await expect(launchManagedChrome('discovery-test')).rejects.toThrow(
      'Stopped at browser version probe',
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      path,
      ['--version'],
      { timeout: 5_000 },
      expect.any(Function),
    );
  }

  it('keeps the explicit browser override ahead of automatic discovery', async () => {
    vi.stubEnv('QWEN_BROWSER_USE_CHROME', ' /custom/chrome ');
    await expectSelectedBrowser('/custom/chrome');
    expect(mocks.executablePath).not.toHaveBeenCalled();
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it.each([
    '/cache/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/cache/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/custom/playwright/chromium-1234/chrome-linux64/chrome',
  ])('uses the installed Playwright browser at %s', async (path) => {
    mocks.executablePath.mockReturnValue(path);
    mocks.access.mockImplementation(async (candidate: string) => {
      if (candidate !== path && candidate !== '/usr/bin/google-chrome') {
        throw new Error('ENOENT');
      }
    });
    await expectSelectedBrowser(path);
  });

  it('falls back to system Chrome if the Playwright browser is absent', async () => {
    mocks.access.mockImplementation(async (candidate: string) => {
      if (candidate !== '/usr/bin/google-chrome') throw new Error('ENOENT');
    });
    await expectSelectedBrowser('/usr/bin/google-chrome');
  });

  it('reports a missing browser before launching a process', async () => {
    await expect(launchManagedChrome('discovery-test')).rejects.toThrow(
      'Chrome was not found; set QWEN_BROWSER_USE_CHROME',
    );
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
