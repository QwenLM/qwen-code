/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPowerShellPermission,
  isPowerShellReadOnly,
} from './powerShellPermissions.js';
import {
  _setPowerShellRuntimeForTest,
  _resetPowerShellRuntimeForTest,
} from '../../utils/shell/powerShell.js';
import type { PathPermissionContext } from '../tool-checkers/checker-reasons.js';
import { interpretPowerShellExitStatus } from '../powerShell.js';

const executable = process.env['CLI_TEST_PWSH_EXE'];
describe.skipIf(!executable)('PowerShell review permission regressions', () => {
  beforeAll(() =>
    _setPowerShellRuntimeForTest({ executable: executable!, edition: 'core' }),
  );
  afterAll(() => _resetPowerShellRuntimeForTest());
  it.each([
    'git -C . diff --exit-code',
    "& '/usr/bin/git' -c color.ui=false diff --exit-code",
    'where.exe missing',
    'fc.exe a b',
    'diff.exe a b',
  ])(
    'interprets special successful exit codes: %s',
    async (command) => {
      expect(
        await interpretPowerShellExitStatus(command, 1, null, 'result'),
      ).toHaveProperty('returnCodeInterpretation');
    },
    15000,
  );
  it.each([
    'where.exe missing',
    'fc.exe a b',
    'diff.exe a b',
    'where missing',
    'fc a b',
  ])(
    'requires native exe identity and output: %s',
    async (command) => {
      expect(await interpretPowerShellExitStatus(command, 1, null)).toEqual({
        isError: true,
      });
    },
    15000,
  );
  const check = (
    command: string,
    rules: PathPermissionContext['rules'] = { allow: {}, deny: {}, ask: {} },
  ) =>
    checkPowerShellPermission(
      { command, executionCwd: process.cwd(), permissionCwd: process.cwd() },
      { rules, additionalDirectories: [] },
      'PowerShell',
    );

  it.each([
    'findstr pattern secret.txt',
    'findstr.exe pattern secret.txt',
    'findstr /g:secret.txt pattern.txt',
  ])(
    'honors file deny for native paths: %s',
    async (command) => {
      expect(
        await check(command, {
          allow: {},
          ask: {},
          deny: { session: ['Read(secret.txt)'] },
        }),
      ).toMatchObject({ kind: 'deny' });
    },
    15000,
  );
  it.each([
    'tree secret-dir',
    'where.exe /r secret-dir file',
    'findstr /s pattern secret.txt',
    'findstr /d:secret-dir pattern secret.txt',
  ])(
    'does not auto-allow recursive native file reads: %s',
    async (command) => {
      expect(await check(command)).toMatchObject({ kind: 'ask' });
    },
    15000,
  );
  it('checks native file ask rules and permits ordinary workspace reads', async () => {
    expect(await check('findstr pattern visible.txt')).toMatchObject({
      kind: 'allow',
    });
    expect(
      await check('findstr pattern visible.txt', {
        allow: {},
        deny: {},
        ask: { session: ['Read(visible.txt)'] },
      }),
    ).toMatchObject({ kind: 'ask' });
  }, 15000);

  it.each([
    'git.exe status',
    '& git status',
    '& "git" status',
    "& 'git' status",
  ])(
    'honors content deny for equivalent command identity: %s',
    async (command) => {
      expect(
        await check(command, {
          deny: { session: ['PowerShell(git:*)'] },
          ask: {},
          allow: {},
        }),
      ).toMatchObject({ kind: 'deny' });
    },
    15000,
  );
  it('normalizes the rule side and retains explicit ask', async () => {
    expect(
      await check('git status', {
        deny: {},
        ask: { session: ['PowerShell(git.exe:*)'] },
        allow: {},
      }),
    ).toMatchObject({ kind: 'ask', reason: { attribution: { type: 'rule' } } });
  });
  it('does not grant arbitrary paths the bare command allow', async () => {
    expect(
      await check("& '/untrusted/git' status", {
        deny: {},
        ask: {},
        allow: { session: ['PowerShell(git:*)'] },
      }),
    ).toMatchObject({ kind: 'ask' });
  });
  it('keeps spaces inside the executable identity', async () => {
    expect(
      await check("& 'example other' status", {
        deny: {},
        ask: {},
        allow: { session: ['PowerShell(example:*)'] },
      }),
    ).toMatchObject({ kind: 'ask' });
  });
  it.each([
    'Get-Process notepad | ForEach-Object -M Kill',
    'Get-Process notepad | ForEach-Object Kill',
    'Get-Process notepad | ForEach-Object -MemberName Kill',
    'Set-ScheduledTask -TaskName example -User example',
    'New-ScheduledTaskAction -Execute example.exe',
    'bitsadmin.exe /transfer job https://example.invalid/a.exe C:\\Temp\\a.exe',
    'Clear-Item Env:QWEN_REVIEW',
    "Clear-Item -Path:'Env:QWEN_REVIEW'",
    'Set-Item Env:QWEN_REVIEW value',
  ])(
    'keeps safety objections ahead of content allow: %s',
    async (command) => {
      expect(
        await check(command, {
          deny: {},
          ask: {},
          allow: { session: [`PowerShell(${command})`] },
        }),
      ).toMatchObject({
        kind: 'ask',
        reason: { attribution: { type: 'safetyCheck' } },
      });
    },
    15000,
  );
  it.each(["npm run '*'", 'npm run build\nnpm run test'])(
    'does not suggest broadening a literal command: %s',
    async (command) => {
      const result = await check(command);
      expect(result.kind).toBe('ask');
      if (result.kind === 'ask') expect(result.suggestions ?? []).toEqual([]);
    },
  );
  it('retains an exact suggestion for a single ordinary command', async () => {
    const result = await check('npm run build');
    expect(result).toMatchObject({
      kind: 'ask',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'PowerShell', ruleContent: 'npm run build' }],
        },
      ],
    });
  });
  it.each(['docker', 'dotnet --list-sdks --list-runtimes'])(
    'recognizes safe native query boundaries: %s',
    async (command) => {
      expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
        true,
      );
    },
    15000,
  );
  it.each(['docker --host example ps', 'dotnet --list-sdks build'])(
    'retains native argument restrictions: %s',
    async (command) => {
      expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
        false,
      );
    },
    15000,
  );
});
