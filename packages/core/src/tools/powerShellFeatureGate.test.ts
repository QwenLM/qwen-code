/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ENV_USE_POWERSHELL_TOOL,
  parsePowerShellToolOverride,
  resolveShellCapabilityDecision,
  resolveShellCapabilitySnapshot,
} from './powerShellFeatureGate.js';

import * as qcs from '../config-service/features/powerShellTool.js';
import * as platform from '../utils/platform.js';
import * as windowsPaths from '../utils/windowsPaths.js';

describe('PowerShell tool capability selection', () => {
  it.each(['1', 'true', 'TRUE', 'yes', 'on'])(
    'parses %s as an explicit enable',
    (value) => {
      expect(parsePowerShellToolOverride(value)).toBe(true);
    },
  );

  it.each(['0', 'false', 'FALSE', 'no', 'off'])(
    'parses %s as an explicit disable',
    (value) => {
      expect(parsePowerShellToolOverride(value)).toBe(false);
    },
  );

  it.each([undefined, '', 'auto', 'invalid'])('treats %s as auto', (value) => {
    expect(parsePowerShellToolOverride(value)).toBeUndefined();
  });

  it('keeps Bash primary when Git Bash exists', () => {
    expect(
      resolveShellCapabilityDecision({
        platform: 'windows',
        hasGitBash: true,
        override: undefined,
        qcsEnabled: false,
      }),
    ).toEqual({
      exposeBash: true,
      exposePowerShell: false,
      defaultShell: 'bash',
    });
  });

  it('adds PowerShell next to Bash when QCS enables it', () => {
    expect(
      resolveShellCapabilityDecision({
        platform: 'windows',
        hasGitBash: true,
        override: undefined,
        qcsEnabled: true,
      }),
    ).toEqual({
      exposeBash: true,
      exposePowerShell: true,
      defaultShell: 'bash',
    });
  });

  it('uses PowerShell when enabled and Git Bash is unavailable', () => {
    expect(
      resolveShellCapabilityDecision({
        platform: 'windows',
        hasGitBash: false,
        override: undefined,
        qcsEnabled: true,
      }),
    ).toEqual({
      exposeBash: false,
      exposePowerShell: true,
      defaultShell: 'powershell',
    });
  });

  it('keeps the original Bash path when explicitly disabled', () => {
    expect(
      resolveShellCapabilityDecision({
        platform: 'windows',
        hasGitBash: false,
        override: false,
        qcsEnabled: true,
      }),
    ).toEqual({
      exposeBash: true,
      exposePowerShell: false,
      defaultShell: 'bash',
    });
  });

  it('only enables PowerShell explicitly on non-Windows platforms', () => {
    expect(
      resolveShellCapabilityDecision({
        platform: 'macos',
        hasGitBash: true,
        override: true,
        qcsEnabled: false,
      }),
    ).toEqual({
      exposeBash: true,
      exposePowerShell: true,
      defaultShell: 'bash',
    });
  });
});

describe('PowerShell Windows capability snapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it.each([
    { override: '', qcsEnabled: false, enabled: false },
    { override: '', qcsEnabled: true, enabled: true },
    { override: 'false', qcsEnabled: true, enabled: false },
    { override: 'true', qcsEnabled: false, enabled: true },
  ])(
    'applies QCS and overrides without Git Bash: %j',
    async ({ override, qcsEnabled, enabled }) => {
      vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
      vi.spyOn(windowsPaths, 'probeGitBashPathSync').mockReturnValue(null);
      vi.spyOn(qcs, 'isPowerShellToolQcsEnabled').mockReturnValue(qcsEnabled);
      vi.stubEnv(ENV_USE_POWERSHELL_TOOL, override);
      expect(await resolveShellCapabilitySnapshot()).toMatchObject({
        exposeBash: !enabled,
        exposePowerShell: enabled,
        defaultShell: enabled ? 'powershell' : 'bash',
      });
    },
  );
  it.each([
    { override: '', qcsEnabled: true, enabled: true },
    { override: '', qcsEnabled: false, enabled: false },
    { override: '0', qcsEnabled: true, enabled: false },
    { override: '1', qcsEnabled: false, enabled: true },
  ])(
    'applies QCS and overrides with Git Bash: %j',
    async ({ override, qcsEnabled, enabled }) => {
      vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
      vi.spyOn(windowsPaths, 'probeGitBashPathSync').mockReturnValue(
        'C:/Git/bin/bash.exe',
      );
      vi.spyOn(qcs, 'isPowerShellToolQcsEnabled').mockReturnValue(qcsEnabled);
      vi.stubEnv(ENV_USE_POWERSHELL_TOOL, override);
      expect(await resolveShellCapabilitySnapshot()).toMatchObject({
        exposeBash: true,
        exposePowerShell: enabled,
        defaultShell: 'bash',
      });
    },
  );
  it('does not change an existing snapshot when Git Bash becomes available', async () => {
    vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
    const probe = vi
      .spyOn(windowsPaths, 'probeGitBashPathSync')
      .mockReturnValue(null);
    vi.stubEnv(ENV_USE_POWERSHELL_TOOL, '1');
    const snapshot = await resolveShellCapabilitySnapshot();
    expect(snapshot.defaultShell).toBe('powershell');
    probe.mockReturnValue('C:/Git/bin/bash.exe');
    const second = await resolveShellCapabilitySnapshot();
    expect(second.defaultShell).toBe('bash');
    expect(second).not.toBe(snapshot);
    expect(snapshot.defaultShell).toBe('powershell');
  });
});
