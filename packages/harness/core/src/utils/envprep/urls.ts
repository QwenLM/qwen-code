/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsEnvironmentUrls } from './types.js';

/** Native Windows artifacts; x64 uses the x86 standalone 7zr extractor. */
export function getWindowsEnvironmentUrls(): WindowsEnvironmentUrls {
  const arm64 = process.platform === 'win32' && process.arch === 'arm64';
  const base = 'https://qwen-code.oss-accelerate.aliyuncs.com/tools';
  return {
    gitBashPrimaryUrl: `${base}/portable-git/2.52.0.windows.1/windows-${arm64 ? 'arm64' : 'x64'}/PortableGit.7z.exe`,
    gitBashFallbackUrl: `https://github.com/git-for-windows/git/releases/download/v2.52.0.windows.1/PortableGit-2.52.0-${arm64 ? 'arm64' : '64-bit'}.7z.exe`,
    sevenZrPrimaryUrl: arm64
      ? `${base}/7zr/26.02/windows-arm64/7zr.exe`
      : `${base}/7zr/26.00/windows-x86/7zr.exe`,
    sevenZrFallbackUrl: 'https://www.7-zip.org/a/7zr.exe',
  };
}
