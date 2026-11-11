/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as platform from '../../utils/platform.js';
import {
  parsePowerShellCommand,
  _setPowerShellParserRunnerForTest,
} from './powerShellParser.js';
import {
  isPowerShellReadOnly,
  checkPowerShellPermission,
} from './powerShellPermissions.js';
import {
  _setPowerShellRuntimeForTest,
  _resetPowerShellRuntimeForTest,
} from '../../utils/shell/powerShell.js';

const executable = process.env['CLI_TEST_PWSH_EXE'];
describe.skipIf(!executable)('PowerShell native read-only analysis', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _setPowerShellParserRunnerForTest();
    _resetPowerShellRuntimeForTest();
  });
  async function prime(command: string) {
    _setPowerShellRuntimeForTest({ executable: executable!, edition: 'core' });
    expect((await parsePowerShellCommand(command)).valid).toBe(true);
  }
  it.each([
    ['docker ps --format json', true],
    ['docker logs --tail 10 container', true],
    ['docker ps --unknown-switch', false],
    ['docker --host remote ps', false],
    ['docker system prune', false],
    ['Get-Content.exe file.txt', false],
    ['Get-Item.exe file.txt', false],
    ['Get-Content -LiteralPath file.txt', true],
    [
      'Microsoft.PowerShell.Management\\Get-Content -LiteralPath file.txt',
      true,
    ],
    ['UnknownModule\\Get-Content -LiteralPath file.txt', false],
    ['Get-Host -UnknownFlag', false],
    ['Format-Table -AutoSize', true],
    ['Format-Table -UnknownFlag', false],
    ['Select-Object -Skip 1', true],
    ['Select-Object -S 1', false],
    ['Where-Object Name -EQ hello', true],
    ['Where-Object -UnknownFlag hello', false],
    ['Out-String -Width 80', true],
    ['Out-String -UnknownFlag', false],
  ])('checks command identity and flags: %s', async (command, expected) => {
    await prime(command);
    expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
      expected,
    );
  });
  it.each([
    ['macos', 'hostname -s', true],
    ['macos', 'hostname -F=hostname-file', false],
    ['macos', 'hostname /a', false],
    ['macos', 'hostname --a', false],
    ['windows', 'whoami /ALL', true],
    ['windows', 'ipconfig /all', true],
    ['windows', 'ipconfig /a', false],
    ['windows', 'hostname -F:hostname-file', false],
  ] as const)(
    'keeps native flag semantics on %s: %s',
    async (osName, command, expected) => {
      await prime(command);
      vi.spyOn(platform, 'getPlatform').mockReturnValue(osName);
      expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
        expected,
      );
    },
  );
  it.each([
    ['Set-Content .git/config x; git status', 'Filesystem changes before Git'],
    [
      'Copy-Item source destination; git status',
      'Filesystem changes before Git',
    ],
    ['Set-Content rg.exe x; rg hello', 'may replace the program'],
    ['Expand-Archive archive.zip; rg hello', 'may replace the program'],
    ['tar xf archive.tar; rg hello', 'may replace the program'],
    ['& C:/Tools/7z.exe x archive.zip; rg hello', 'may replace the program'],
    [
      '& C:/Tools/robocopy.exe source target; git status',
      'Filesystem changes before Git',
    ],
    ['./script.ps1', 'Shell script invocation'],
    [
      'schtasks.exe /Create /TN example /TR example.exe /SC DAILY',
      'requires confirmation',
    ],
    [
      '& C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -EncodedCommand WA==',
      'requires confirmation',
    ],
    ['Invoke-Expression "Write-Output hello"', 'requires confirmation'],
    ['Write-Output $(Get-Content file.txt)', 'require confirmation'],
    ['Write-Output @values', 'require confirmation'],
    ['[System.IO.File]::ReadAllText("file.txt")', 'require confirmation'],
    ['New-Object -ComObject WScript.Shell', 'requires confirmation'],
    ['Start-Process example.exe -Verb RunAs', 'requires confirmation'],
    [
      'Invoke-CimMethod -ClassName Win32_Process -MethodName Create',
      'requires confirmation',
    ],
    ['Import-Module example', 'requires confirmation'],
    ['Install-Module example', 'requires confirmation'],
    ['Save-Script example -Path target', 'requires confirmation'],
    [
      '& C:/Windows/System32/wbem/wmic.exe process call create example.exe',
      'requires confirmation',
    ],
    [
      'icim -ClassName Win32_Process -MethodName Create',
      'requires confirmation',
    ],
    ['iwmi -Class Win32_Process -Name Create', 'requires confirmation'],
    ['bash -c echo', 'requires confirmation'],
    ['Start-Job -FilePath script.ps1', 'requires confirmation'],
    ['Enter-PSSession remote-host', 'requires confirmation'],
    ['$env:EXAMPLE = "value"', 'require confirmation'],
    ['Write-Output hello -OutVariable capture', 'require confirmation'],
    ['Write-Output hello -ErrorAction Inquire', 'require confirmation'],
    ['Set-Location child; Get-Content file.txt', 'requires confirmation'],

    ['UnknownModule\\Get-Content file.txt', 'unverified module-qualified'],
    [
      'Start-BitsTransfer https://example.invalid/tool.exe tool.exe',
      'unverified file targets',
    ],
    [
      'certutil -urlcache -split -f https://example.invalid/tool.exe tool.exe',
      'unverified file targets',
    ],
  ])(
    'keeps combination safety ahead of exact allow: %s',
    async (command, reason) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-combination-'));
      try {
        await prime(command);
        const result = await checkPowerShellPermission(
          { command, executionCwd: cwd, permissionCwd: cwd },
          {
            rules: {
              allow: { session: [`PowerShell(${command})`] },
              ask: {},
              deny: {},
            },
            additionalDirectories: [],
          },
          'PowerShell',
        );
        expect(result).toMatchObject({
          kind: 'ask',
          reason: {
            attribution: { type: 'safetyCheck', classifierApprovable: false },
          },
        });
        if (result.kind === 'ask')
          expect(result.reason.message).toContain(reason);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
  it('allows an approved unrelated write followed by a read-only command', async () => {
    const command = 'Set-Content notes.txt hello; Write-Output done';
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-combination-'));
    try {
      await prime(command);
      expect(
        await checkPowerShellPermission(
          { command, executionCwd: cwd, permissionCwd: cwd },
          {
            rules: {
              allow: { session: [`PowerShell(${command})`] },
              ask: {},
              deny: {},
            },
            additionalDirectories: [],
          },
          'PowerShell',
        ),
      ).toMatchObject({ kind: 'allow' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it('does not allow a cwd executable to inherit a native allow rule on Windows', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-shadow-'));
    try {
      await prime('git status');
      writeFileSync(path.join(cwd, 'git.exe'), 'not executed');
      vi.spyOn(platform, 'getPlatform').mockReturnValue('windows');
      expect(await isPowerShellReadOnly('git status', { cwd })).toBe(false);
      const result = await checkPowerShellPermission(
        { command: 'git status', executionCwd: cwd, permissionCwd: cwd },
        {
          rules: {
            allow: { session: ['PowerShell(git:*)'] },
            ask: {},
            deny: {},
          },
          additionalDirectories: [],
        },
        'PowerShell',
      );
      expect(result).toMatchObject({
        kind: 'ask',
        reason: { attribution: { type: 'safetyCheck' } },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
