/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ENV_PWSH_PARSE_TIMEOUT_MS,
  _setPowerShellParserRunnerForTest,
  parsePowerShellCommand,
  canonicalizePowerShellCommandName,
  getAllParsedPowerShellCommands,
} from './powerShellParser.js';
import {
  _setPowerShellRuntimeForTest,
  _resetPowerShellRuntimeForTest,
} from '../../utils/shell/powerShell.js';

import {
  checkPowerShellPermission,
  isPowerShellReadOnly,
} from './powerShellPermissions.js';

const executable = process.env['CLI_TEST_PWSH_EXE'];
// Explicit runtime makes the real-process gate reproducible on Mac and Windows.
describe.skipIf(!executable)('PowerShell real AST parser', () => {
  afterEach(() => {
    _setPowerShellParserRunnerForTest();
    _resetPowerShellRuntimeForTest();
  });
  async function parse(command: string) {
    _setPowerShellRuntimeForTest({ executable: executable!, edition: 'core' });
    const parsed = await parsePowerShellCommand(command);
    expect(parsed.errors).toEqual([]);
    expect(parsed.valid).toBe(true);
    return parsed;
  }
  it('keeps top-level and nested commands separate without executing the input', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'test-ps-ast-'));
    const target = path.join(directory, 'must-not-exist');
    try {
      const parsed = await parse(
        `Write-Output $(Set-Content '${target.replaceAll("'", "''")}' 'x')`,
      );
      expect(parsed.statements[0].commands.map((c) => c.name)).toEqual([
        'Write-Output',
      ]);
      expect(parsed.statements[0].nestedCommands?.map((c) => c.name)).toEqual([
        'Set-Content',
      ]);
      expect(getAllParsedPowerShellCommands(parsed).map((c) => c.name)).toEqual(
        ['Write-Output', 'Set-Content'],
      );
      await expect(access(target)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retains named blocks, traps and control flow', async () => {
    const parsed = await parse(
      'begin { Write-Output a } process { if ($true) { Remove-Item x } } end { trap { Write-Output failed }; Get-Location }',
    );
    expect(parsed.statements.map((s) => s.blockType)).toContain('BeginBlock');
    expect(parsed.statements.map((s) => s.blockType)).toContain('ProcessBlock');
    expect(
      parsed.statements.some((s) => s.statementType === 'TrapStatementAst'),
    ).toBe(true);
    const condition = parsed.statements.find(
      (s) => s.statementType === 'IfStatementAst',
    );
    expect(condition?.commands).toEqual([]);
    expect(condition?.nestedCommands?.map((c) => c.name)).toEqual([
      'Remove-Item',
    ]);
  });
  it('preserves static values, colon parameters, splatting and redirection semantics', async () => {
    const parsed = await parse(
      'Get-Content -LiteralPath:"a b.txt" @options 2>&1 >> "out file.txt"',
    );
    expect(parsed.splattedVariables).toEqual(['options']);
    const command = parsed.statements[0].commands[0];
    const parameter = command.elements[1];
    expect(parameter.parameterName).toBe('LiteralPath');
    expect(parameter.children[0].staticValue).toBe('a b.txt');
    expect(command.redirectionDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'merge',
          fromStream: 'Error',
          toStream: 'Output',
        }),
        expect.objectContaining({
          kind: 'file',
          append: true,
          target: expect.objectContaining({ staticValue: 'out file.txt' }),
        }),
      ]),
    );
  });
  it('preserves literal here-string newlines and Unicode', async () => {
    const parsed = await parse("Write-Output @'\r\n中文😀\r\nline two\r\n'@");
    expect(parsed.statements[0].commands[0].elements[1].staticValue).toBe(
      '中文😀\r\nline two',
    );
  });
  it.each([
    'if ($true) { Get-Location }',
    'Write-Output $(Get-Location)',
    'Set-Location /tmp; Get-Content secret.txt',
    'git log --output=example.txt',
  ])(
    'does not auto-allow unverified structure or writing native args: %s',
    async (command) => {
      await parse(command);
      expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
        false,
      );
      expect(
        (
          await checkPowerShellPermission(
            {
              command,
              executionCwd: process.cwd(),
              permissionCwd: process.cwd(),
            },
            {
              rules: { allow: {}, ask: {}, deny: {} },
              additionalDirectories: [],
            },
            'PowerShell',
          )
        ).kind,
      ).toBe('ask');
    },
  );

  it.each([
    'param($value = (Get-Content blocked.secret)) Write-Output hello',
    'param([ValidateScript({ Get-Content blocked.secret })] $value) Write-Output hello',
  ])(
    'retains parameter execution for safety and deny checks: %s',
    async (command) => {
      const parsed = await parse(command);
      expect(
        getAllParsedPowerShellCommands(parsed).map((entry) => entry.name),
      ).toContain('Get-Content');
      expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
        false,
      );
      expect(
        (
          await checkPowerShellPermission(
            {
              command,
              executionCwd: process.cwd(),
              permissionCwd: process.cwd(),
            },
            {
              rules: {
                allow: {},
                ask: {},
                deny: { session: ['Read(*.secret)'] },
              },
              additionalDirectories: [],
            },
            'PowerShell',
          )
        ).kind,
      ).toBe('deny');
    },
  );
  it.each([
    ['using namespace System; Write-Output hello', 'hasUsingStatements'],
    ['#requires -Version 7.0\nWrite-Output hello', 'hasScriptRequirements'],
    ['Write-Output hello &', 'hasBackgroundJob'],
    ['cmd --% /c echo literal', 'hasStopParsing'],
  ] as const)('retains script safety metadata: %s', async (command, field) => {
    const parsed = await parse(command);
    expect(parsed[field]).toBe(true);
    expect(await isPowerShellReadOnly(command, { cwd: process.cwd() })).toBe(
      false,
    );
  });
  it.each(["Write-Output '--%'", '# --%\nWrite-Output literal'])(
    'does not interpret quoted or commented stop-parsing text: %s',
    async (command) => {
      expect((await parse(command)).hasStopParsing).toBe(false);
    },
  );
  it('returns structured parse errors', async () => {
    _setPowerShellRuntimeForTest({ executable: executable!, edition: 'core' });
    const parsed = await parsePowerShellCommand('Get-Content "unfinished');
    expect(parsed.valid).toBe(false);
    expect(parsed.structuredErrors?.[0].errorId).toBeTruthy();
  });
});

describe('PowerShell command identity', () => {
  it.each([
    '\\Get-Content',
    '.\\Get-Content',
    'C:\\Get-Content',
    '/Get-Content',
  ])('does not turn an executable path into a cmdlet: %s', (name) => {
    expect(canonicalizePowerShellCommandName(name)).toBe(name);
  });
});

describe('PowerShell parser resource bounds', () => {
  const success = {
    stdout: JSON.stringify({ valid: true, statements: [] }),
    stderr: '',
    exitCode: 0,
    timedOut: false,
  };
  beforeEach(() => {
    _setPowerShellRuntimeForTest({
      executable: 'test-runtime',
      edition: 'core',
    });
  });
  afterEach(() => {
    _setPowerShellParserRunnerForTest();
    _resetPowerShellRuntimeForTest();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    { ...success, stdout: '' },
    { ...success, stdout: 'invalid JSON' },
    { ...success, exitCode: 1, stderr: 'startup error' },
    { ...success, timedOut: true },
  ])(
    'retries transient failures twice without caching them: %j',
    async (failure) => {
      const runner = vi.fn().mockResolvedValue(failure);
      _setPowerShellParserRunnerForTest(runner);
      expect((await parsePowerShellCommand('Get-Date')).valid).toBe(false);
      expect(runner).toHaveBeenCalledTimes(2);
      runner.mockResolvedValue(success);
      expect((await parsePowerShellCommand('Get-Date')).valid).toBe(true);
      expect(runner).toHaveBeenCalledTimes(3);
    },
  );
  it('bounds a runner that never settles', async () => {
    vi.useFakeTimers();
    vi.stubEnv(ENV_PWSH_PARSE_TIMEOUT_MS, '20');
    const runner = vi.fn(() => new Promise<never>(() => {}));
    _setPowerShellParserRunnerForTest(runner);
    const result = parsePowerShellCommand('Get-Date');
    await vi.advanceTimersByTimeAsync(81);
    expect((await result).valid).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it('applies the byte limit before invoking the parser', async () => {
    const runner = vi.fn().mockResolvedValue(success);
    _setPowerShellParserRunnerForTest(runner);
    expect((await parsePowerShellCommand('中'.repeat(1501))).valid).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
  it('shares an in-flight parse and caches its syntax result', async () => {
    const runner = vi.fn().mockResolvedValue(success);
    _setPowerShellParserRunnerForTest(runner);
    const first = parsePowerShellCommand('Get-Date');
    const second = parsePowerShellCommand('Get-Date');
    expect(first).toBe(second);
    await first;
    await parsePowerShellCommand('Get-Date');
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('evicts old syntax results beyond the 256-entry bound', async () => {
    const runner = vi.fn().mockResolvedValue(success);
    _setPowerShellParserRunnerForTest(runner);
    for (let index = 0; index < 257; index++)
      await parsePowerShellCommand(`Write-Output ${index}`);
    await parsePowerShellCommand('Write-Output 1');
    expect(runner).toHaveBeenCalledTimes(257);
    await parsePowerShellCommand('Write-Output 0');
    expect(runner).toHaveBeenCalledTimes(258);
  });
});
