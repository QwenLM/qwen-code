/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWindowsEnvironmentUrls } from './urls.js';
import { GitBashPreparer } from './gitBashPreparer.js';
import { SevenZrPreparer } from './sevenZrPreparer.js';
import { prepareWindowsEnvironment } from './prepareWindowsEnvironment.js';
import { getGitBashPreparationState } from './index.js';

afterEach(() => vi.restoreAllMocks());

describe('Windows environment download sources', () => {
  it.each([
    ['x64', 'windows-x64', '26.00/windows-x86', '64-bit'],
    ['arm64', 'windows-arm64', '26.02/windows-arm64', 'arm64'],
  ] as const)(
    'selects Qwen OSS artifacts for Windows %s',
    (arch, gitArch, sevenZr, fallbackArch) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
      expect(getWindowsEnvironmentUrls()).toEqual({
        gitBashPrimaryUrl: `https://qwen-code.oss-accelerate.aliyuncs.com/tools/portable-git/2.52.0.windows.1/${gitArch}/PortableGit.7z.exe`,
        gitBashFallbackUrl: `https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/PortableGit-2.52.0-${fallbackArch}.7z.exe`,
        sevenZrPrimaryUrl: `https://qwen-code.oss-accelerate.aliyuncs.com/tools/7zr/${sevenZr}/7zr.exe`,
        sevenZrFallbackUrl: 'https://www.7-zip.org/a/7zr.exe',
      });
    },
  );

  it.each(['darwin', 'linux'] as const)(
    'skips preparation on %s',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const git = new GitBashPreparer('/unused');
      const sevenZr = new SevenZrPreparer('/unused');
      await expect(git.isRequired()).resolves.toBe(false);
      await expect(sevenZr.isRequired()).resolves.toBe(false);
      const stop = await prepareWindowsEnvironment(
        new AbortController().signal,
      );
      expect(getGitBashPreparationState()).toEqual({ status: 'idle' });
      await stop();
    },
  );

  it('rejects an already aborted startup', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareWindowsEnvironment(controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getGitBashPreparationState()).toEqual({ status: 'idle' });
  });
});
