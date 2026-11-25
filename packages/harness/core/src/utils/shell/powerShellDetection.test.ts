/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as platform from '../platform.js';
import {
  getPowerShellRuntime,
  _resetPowerShellRuntimeForTest,
} from './powerShell.js';

describe('PowerShell runtime fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    _resetPowerShellRuntimeForTest();
  });
  it('uses SYSTEMROOT only after PATH and PowerShell 7 candidates fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'test-ps-detect-'));
    try {
      vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
      for (const key of ['PATH', 'ProgramFiles', 'LOCALAPPDATA', 'USERPROFILE'])
        vi.stubEnv(key, '');
      vi.stubEnv('SYSTEMROOT', root);
      const executable = path.join(
        root,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, '', { mode: 0o755 });
      expect(await getPowerShellRuntime()).toEqual({
        executable,
        edition: 'desktop',
      });
      _resetPowerShellRuntimeForTest();
      const programFiles = path.join(root, 'Programs');
      const pwsh = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
      await mkdir(path.dirname(pwsh), { recursive: true });
      await writeFile(pwsh, '', { mode: 0o755 });
      vi.stubEnv('ProgramFiles', programFiles);
      expect(await getPowerShellRuntime()).toEqual({
        executable: pwsh,
        edition: 'core',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not invent a Windows system path when SYSTEMROOT is missing', async () => {
    vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
    for (const key of [
      'PATH',
      'ProgramFiles',
      'LOCALAPPDATA',
      'USERPROFILE',
      'SYSTEMROOT',
    ])
      vi.stubEnv(key, '');
    expect(await getPowerShellRuntime()).toBeNull();
  });
});
