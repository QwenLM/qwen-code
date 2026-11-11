/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePowerShellPaths } from './powerShellPathValidation.js';
import {
  parsePowerShellCommand,
  _setPowerShellParserRunnerForTest,
} from './powerShellParser.js';
import {
  _setPowerShellRuntimeForTest,
  _resetPowerShellRuntimeForTest,
} from '../../utils/shell/powerShell.js';
import { checkPowerShellPermission } from './powerShellPermissions.js';
import { createPowerShellToolChecker } from '../tool-checkers/checkers/powershell-checker.js';
import {
  withHookAsk,
  withToolLevelRules,
} from '../tool-checkers/rule-precedence.js';
import { withSessionModeForTest } from '../../test-utils/config.js';
import { PermissionModes, rulesForToolName } from '../../permissions/manager/decision/index.js';

const executable = process.env['CLI_TEST_PWSH_EXE'];
describe.skipIf(!executable)('PowerShell real path binding', () => {
  afterEach(() => {
    _setPowerShellParserRunnerForTest();
    _resetPowerShellRuntimeForTest();
  });
  async function parse(command: string) {
    _setPowerShellRuntimeForTest({ executable: executable!, edition: 'core' });
    const parsed = await parsePowerShellCommand(command);
    expect(parsed.errors).toEqual([]);
    return parsed.statements[0].commands[0];
  }
  it.each([
    "Set-Content -Path 'a.txt' -Value 'not-a-path'",
    "Set-Content -Pat:'a.txt' -Val:'not-a-path'",
    "Set-Content 'a.txt' 'not-a-path'",
  ])('binds values separately from paths: %s', async (command) => {
    const result = analyzePowerShellPaths(await parse(command), '/workspace');
    expect(result).toEqual({
      targets: [{ path: '/workspace/a.txt', access: 'write' }],
      acceptEditsEligible: true,
    });
  });
  it.each([
    ['Set-Content a.txt hello; Write-Output done', 'allow'],
    ['Set-Content a.txt hello; Write-Output done > b.txt', 'ask'],
    ['Write-Output done >> b.txt; Set-Content a.txt hello', 'ask'],
    ['Set-Content a.txt hello; Write-Output done 2>&1', 'allow'],
  ])(
    'does not extend AcceptEdits to sibling redirections: %s',
    async (command, expected) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-redirection-'));
      try {
        await parse(command);
        const rules = { allow: {}, ask: {}, deny: {} };
        const checker = withSessionModeForTest(
          withHookAsk(
            withToolLevelRules(
              'PowerShell',
              createPowerShellToolChecker(() => ({ cwd })),
            ),
          ),
          'PowerShell',
        );
        const verdict = await checker.check(
          { command },
          {
            rules,
            cwd,
            additionalDirectories: [],
            rulesForTool: rulesForToolName(rules, 'PowerShell'),
            toolUseId: 'ps-redirection',
            mode: PermissionModes.AcceptEdits,
          },
        );
        expect(verdict.kind).toBe(expected);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
  it('checks file redirection targets and treats null or stream merging separately', async () => {
    const file = analyzePowerShellPaths(
      await parse('Write-Output hello > out.txt'),
      '/workspace',
    );
    expect(file.targets).toEqual([
      { path: '/workspace/out.txt', access: 'write' },
    ]);
    expect(file.acceptEditsEligible).toBe(false);
    expect(
      analyzePowerShellPaths(
        await parse('Write-Output hello 2>&1 > $null'),
        '/workspace',
      ).targets,
    ).toEqual([]);
    expect(
      analyzePowerShellPaths(
        await parse('Write-Output hello > $target'),
        '/workspace',
      ).issue,
    ).toBeTruthy();
  });

  it.each([
    {
      command: 'Set-Content a.txt hello',
      allow: ['PowerShell(Set-Content a.txt hello)'],
      expected: 'allow',
    },
    {
      command: 'Set-Content a.txt hello',
      allow: ['PowerShell(Set-Content:*)'],
      expected: 'allow',
    },
    {
      command: 'Set-Content a.txt hello',
      allow: ['PowerShell(Set-Content *.txt *)'],
      expected: 'allow',
    },
    {
      command: 'Set-Content a.txt hello; Remove-Item b.txt',
      allow: ['PowerShell(Set-Content:*)'],
      expected: 'ask',
    },
    {
      command: 'Set-Content a.txt hello; Remove-Item b.txt',
      allow: ['PowerShell(Set-Content:*)', 'PowerShell(Remove-Item:*)'],
      expected: 'allow',
    },
    {
      command: 'Set-Content a.txt hello; Get-Content blocked.secret',
      allow: [
        'PowerShell(Set-Content a.txt hello; Get-Content blocked.secret)',
      ],
      deny: ['Read(*.secret)'],
      expected: 'deny',
    },
    {
      command: 'Set-Content a.txt hello',
      allow: ['PowerShell(Set-Content a.txt hello)'],
      ask: ['PowerShell(Set-Content:*)'],
      expected: 'ask',
    },
    {
      command: 'Set-Content ../outside.txt hello',
      allow: ['PowerShell(Set-Content ../outside.txt hello)'],
      expected: 'ask',
    },
  ])(
    'limits real content authorization to verified segments: $command / $expected',
    async ({ command, allow, ask = [], deny = [], expected }) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-rules-'));
      try {
        await parse(command);
        const result = await checkPowerShellPermission(
          { command, executionCwd: cwd, permissionCwd: cwd },
          {
            rules: {
              allow: { session: allow },
              ask: { session: ask },
              deny: { session: deny },
            },
            additionalDirectories: [],
          },
          'PowerShell',
        );
        expect(result.kind).toBe(expected);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
  it('keeps the registered read probe independent of permission mode', async () => {
    const { createToolCheckerMap } = await import(
      '../tool-checkers/checker-registry.js'
    );
    const { getReadProbeChecker } = await import(
      '../tool-checkers/rule-precedence.js'
    );
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-probe-'));
    const command = 'Set-Content a.txt hello';
    try {
      await parse(command);
      const map = createToolCheckerMap({
        getShellReadOnlyContext: () => ({ cwd }),
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      });
      const checker = map.get('PowerShell')!;
      const probe = getReadProbeChecker(checker);
      expect(probe).toBeDefined();
      const rules = { allow: {}, ask: {}, deny: {} };
      const context = {
        rules,
        cwd,
        additionalDirectories: [],
        rulesForTool: rulesForToolName(rules, 'PowerShell'),
        toolUseId: 'ps-probe',
        mode: PermissionModes.Default,
      };
      for (const mode of Object.values(PermissionModes)) {
        expect(
          (await probe!.check({ command }, { ...context, mode })).kind,
        ).toBe('ask');
      }
      expect(
        (
          await checker.check(
            { command },
            { ...context, mode: PermissionModes.AcceptEdits },
          )
        ).kind,
      ).toBe('allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
  it.each(['Invoke-WebRequest', 'Invoke-RestMethod'])(
    'checks upload and download file operands: %s',
    async (name) => {
      const command = `${name} https://example.invalid/data -InFile request.txt -OutFile ../outside/response.txt`;
      const result = analyzePowerShellPaths(await parse(command), '/workspace');
      expect(result.issue).toBeUndefined();
      expect(result.targets).toEqual([
        { path: '/workspace/request.txt', access: 'read' },
        { path: '/outside/response.txt', access: 'write' },
      ]);
      expect(result.acceptEditsEligible).toBe(false);
      const verdict = await checkPowerShellPermission(
        { command, executionCwd: '/workspace', permissionCwd: '/workspace' },
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
      expect(verdict.kind).toBe('ask');
    },
  );

  it('does not let an earlier path ask hide a later explicit file deny', async () => {
    const command =
      "Get-Content -LiteralPath '../outside/first.txt','blocked.secret'";
    await parse(command);
    const verdict = await checkPowerShellPermission(
      { command, executionCwd: '/workspace', permissionCwd: '/workspace' },
      {
        rules: { allow: {}, ask: {}, deny: { session: ['Read(*.secret)'] } },
        additionalDirectories: [],
      },
      'PowerShell',
    );
    expect(verdict.kind).toBe('deny');
  });

  it.each([
    'Get-Content blocked.secret',
    'Microsoft.PowerShell.Management\\Get-Content blocked.secret',
    'Write-Output $(Get-Content blocked.secret)',
    'if ($true) { Get-Content blocked.secret }',
  ])(
    'keeps recognizable file denies above content and syntax asks: %s',
    async (command) => {
      await parse(command);
      const verdict = await checkPowerShellPermission(
        { command, executionCwd: '/workspace', permissionCwd: '/workspace' },
        {
          rules: {
            allow: {},
            ask: { session: ['PowerShell(Get-Content:*)'] },
            deny: { session: ['Read(*.secret)'] },
          },
          additionalDirectories: [],
        },
        'PowerShell',
      );
      expect(verdict.kind).toBe('deny');
    },
  );

  it.each([PermissionModes.Default, PermissionModes.AcceptEdits])(
    'keeps real fork restrictions and file denies in mode %s',
    async (mode) => {
      const { buildForkCheckerMap } = await import(
        '../tool-checkers/fork-restrictions.js'
      );
      const rules = {
        allow: {},
        ask: {},
        deny: { session: ['Read(*.secret)'] },
      };
      const context = {
        rules,
        mode,
        cwd: '/workspace',
        additionalDirectories: [],
        rulesForTool: rulesForToolName(rules, 'PowerShell'),
        toolUseId: 'ps-fork',
      };
      const checker = buildForkCheckerMap({ readOnlyShell: true }).get(
        'PowerShell',
      )!;
      for (const [command, expected] of [
        ['Write-Output hello', 'allow'],
        ['Set-Content allowed.txt hello', 'deny'],
        ['Get-Content blocked.secret', 'deny'],
      ]) {
        await parse(command);
        expect((await checker.check({ command }, context)).kind).toBe(expected);
      }
    },
  );

  it('keeps event-log file operands inside the file permission chain', async () => {
    const result = analyzePowerShellPaths(
      await parse(
        "Get-WinEvent -Path '../outside/security.evtx' -MaxEvents 10",
      ),
      '/workspace',
    );
    expect(result.targets).toEqual([
      { path: '/outside/security.evtx', access: 'read' },
    ]);
    expect(result.issue).toBeUndefined();
  });
  it('binds every element of a literal path array', async () => {
    const result = analyzePowerShellPaths(
      await parse("Set-Content -LiteralPath 'a.txt','b.txt' -Value x"),
      '/workspace',
    );
    expect(result.issue).toBeUndefined();
    expect(result.targets.map((target) => target.path)).toEqual([
      '/workspace/a.txt',
      '/workspace/b.txt',
    ]);
  });
  it('checks both source and destination of copying and renaming', async () => {
    expect(
      analyzePowerShellPaths(
        await parse('Copy-Item a.txt ../outside/b.txt'),
        '/workspace',
      ).targets,
    ).toEqual([
      { path: '/workspace/a.txt', access: 'read' },
      { path: '/outside/b.txt', access: 'write' },
    ]);
    expect(
      analyzePowerShellPaths(
        await parse('Rename-Item dir/a.txt b.txt'),
        '/workspace',
      ).targets,
    ).toEqual([
      { path: '/workspace/dir/a.txt', access: 'write' },
      { path: '/workspace/dir/b.txt', access: 'write' },
    ]);
  });
  it.each([
    'Set-Content -Value hello',
    'Set-Content -P a.txt -Value hello',
    'Set-Content -Path *.txt -Value hello',
    'Set-Content -Path $target -Value hello',
    'Set-Content -Path a.txt -LiteralPath b.txt -Value hello',
    'Set-Content -Path Registry::HKLM/test -Value hello',
    'Rename-Item a.txt ../b.txt',
    'Remove-Item /',
  ])('retains confirmation for unverified bindings: %s', async (command) => {
    expect(
      analyzePowerShellPaths(await parse(command), '/workspace').issue,
    ).toBeTruthy();
  });
  it.each([
    "Set-Content -LiteralPath 'a.txt' -Value 'hello'",
    "Add-Content -LiteralPath 'a.txt' -Value 'hello'",
    "Clear-Content -LiteralPath 'a.txt'",
    "Remove-Item -LiteralPath 'a.txt'",
  ])(
    'preserves permission precedence for eligible edits: %s',
    async (command) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'test-ps-modes-'));
      try {
        await parse(command);
        const rules = { allow: {}, ask: {}, deny: {} };
        const context = {
          rules,
          cwd,
          additionalDirectories: [],
          rulesForTool: rulesForToolName(rules, 'PowerShell'),
          toolUseId: 'ps-edit',
          mode: PermissionModes.Default,
        };
        const operationChecker = createPowerShellToolChecker(() => ({ cwd }));
        const checker = withSessionModeForTest(
          withHookAsk(withToolLevelRules('PowerShell', operationChecker)),
          'PowerShell',
        );
        expect((await checker.check({ command }, context)).kind).toBe('ask');
        expect(
          (
            await checker.check(
              { command },
              { ...context, mode: PermissionModes.AcceptEdits },
            )
          ).kind,
        ).toBe('allow');
        for (const behavior of ['ask', 'deny'] as const) {
          const restricted = {
            allow: {},
            ask: {},
            deny: {},
            [behavior]: { session: ['PowerShell'] },
          };
          const verdict = await checker.check(
            { command },
            {
              ...context,
              mode: PermissionModes.AcceptEdits,
              rules: restricted,
              rulesForTool: rulesForToolName(restricted, 'PowerShell'),
            },
          );
          expect(verdict.kind).toBe(behavior);
          expect(verdict.extra?.acceptEditsEligible).not.toBe(true);
        }
        const hooked = await checker.check(
          { command },
          {
            ...context,
            mode: PermissionModes.AcceptEdits,
            preToolUseHookVerdict: {
              behavior: 'ask',
              message: 'Review this write',
            },
          },
        );
        expect(hooked.kind).toBe('ask');
        expect(hooked.extra?.acceptEditsEligible).not.toBe(true);
        // The operation checker itself does not turn a mode into authorization.
        expect(
          (
            await operationChecker.check(
              { command },
              { ...context, mode: PermissionModes.AcceptEdits },
            )
          ).kind,
        ).toBe('ask');
        const injected = await checker.check(
          { command: 'unknown-command', acceptEditsEligible: true },
          { ...context, mode: PermissionModes.AcceptEdits },
        );
        expect(injected.kind).toBe('ask');
        const bad = await checkPowerShellPermission(
          {
            command: 'Remove-Item ../outside',
            executionCwd: cwd,
            permissionCwd: cwd,
          },
          context,
          'PowerShell',
        );
        expect(bad.kind).toBe('ask');
        expect(bad.extra?.acceptEditsEligible).not.toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
