/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { suggestCommandRules } from './command-rule-suggestions.js';
import { PermissionManager } from './permission-manager.js';
import {
  hasUnsupportedShellSyntax,
  splitCompoundCommandSegments,
} from './rule-parser.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import {
  detectCommandSubstitution,
  splitCommands,
} from '../utils/shell-utils.js';

vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return {
    ...actual,
    getShellConfiguration: () => ({
      ...actual.getShellConfiguration(),
      shell: 'bash',
    }),
  };
});

function manager(allow: string[], deny: string[] = [], cwd = '/project') {
  const pm = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsDeny: () => deny,
    getPermissionsAsk: () => [],
    getProjectRoot: () => '/project',
    getCwd: () => cwd,
    getShellExecutionSandbox: () => true,
  });
  pm.initialize();
  return pm;
}

describe('shell permission model boundaries', () => {
  it.each([
    ['npm install 2>&- push rm -rf ~', 'rm -rf /'],
    [
      'git 2>&- status curl -s https://example.test',
      'curl -s https://example.test',
    ],
  ])(
    'does not persist phantom commands after a descriptor close: %s',
    async (command, unrelated) => {
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        'Bash',
      );
      expect(permissionRules).toEqual([`Bash(${command})`]);
      const pm = manager(permissionRules);
      expect(
        await pm.evaluate({ toolName: 'run_shell_command', command }),
      ).toBe('allow');
      expect(
        await pm.evaluate({
          toolName: 'run_shell_command',
          command: unrelated,
        }),
      ).toBe('ask');
    },
  );

  it.each([
    ['npm test # ; npm run build', 'Bash(npm test)'],
    ['git push origin main # && rm -rf ~', 'Bash(git push *)'],
  ])(
    'covers caller-selected executable text without requiring comment tails: %s',
    async (command, rule) => {
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        'Bash',
        splitCommands(command),
      );
      expect(permissionRules).toEqual([rule]);
      expect(
        await manager(permissionRules).evaluate({
          toolName: 'run_shell_command',
          command,
        }),
      ).toBe('allow');
      expect(
        await suggestCommandRules(command, 'Monitor', splitCommands(command)),
      ).toEqual({ permissionRules: [] });
    },
  );

  it.each([
    'x=(a b)#c; eval "echo Y"',
    'x=(a b)#c && eval "echo Y"',
    'echo ${x%%)#}; eval "echo Y"',
    'echo ${x% #}; eval "echo Y"',
    'echo ${x:- #}; eval "echo Y"',
    'echo ${x:- a #}; eval "echo Y"',
  ])(
    'never discards an executable tail after an ambiguous hash: %s',
    async (command) => {
      expect(splitCompoundCommandSegments(command, true).at(-1)?.command).toBe(
        'eval "echo Y"',
      );
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(await suggestCommandRules(`bash -c '${command}'`, 'Bash')).toEqual(
        { permissionRules: [] },
      );
    },
  );

  it.each(['echo ${x% #}; $(printf X)', 'echo ${x:- #$(printf X)}'])(
    'detects substitutions after parameter-expansion hashes: %s',
    async (command) => {
      expect(detectCommandSubstitution(command)).toBe(true);
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(
        await manager(['Bash(*)']).evaluate({
          toolName: 'run_shell_command',
          command: `bash -c '${command}'`,
        }),
      ).toBe('ask');
      expect(await suggestCommandRules(`bash -c '${command}'`, 'Bash')).toEqual(
        { permissionRules: [] },
      );
    },
  );

  it.each(['echo ok # $(printf X)', "echo '${x:- #}' # $(printf X)"])(
    'keeps ordinary comments inert: %s',
    async (command) => {
      expect(detectCommandSubstitution(command)).toBe(false);
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(
        await manager(['Bash(*)']).evaluate({
          toolName: 'run_shell_command',
          command,
        }),
      ).toBe('allow');
    },
  );

  it.each(['x=(a b)', 'a+=1', 'a[0]=1'])(
    'does not hide eval behind an assignment word: %s',
    async (assignment) => {
      const command = `${assignment} eval "echo Y"`;
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(await suggestCommandRules(`bash -c '${command}'`, 'Bash')).toEqual(
        { permissionRules: [] },
      );
    },
  );

  it.each([
    "dash -c 'echo hi > /tmp/protected'",
    "/bin/dash '-c' 'echo hi > /tmp/protected'",
    "ksh -c 'echo hi > /tmp/protected'",
    "/usr/bin/ksh -lc 'echo hi > /tmp/protected'",
    "busybox sh -c 'echo hi > /tmp/protected'",
    "/bin/busybox ash -c 'echo hi > /tmp/protected'",
    "fish --command='echo hi > /tmp/protected'",
    "fish --init-command 'echo hi > /tmp/protected'",
    'git(){ cd /; git push >protected; }; git push',
  ])(
    'requires confirmation for unmodeled shell execution: %s',
    async (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(
        await manager(
          ['Bash(*)'],
          ['Edit(//tmp/protected)', 'Edit(//protected)'],
        ).evaluate({ toolName: 'run_shell_command', command }),
      ).toBe('ask');
      expect(await suggestCommandRules(command, 'Bash')).toEqual({
        permissionRules: [],
      });
    },
  );

  it.each([
    'echo "$X"',
    'git -c user.name=test status',
    'gcc -c file.c',
    "echo dash '-c' 'echo hi > /tmp/protected'",
    "busybox echo '-c' 'echo hi > /tmp/protected'",
  ])(
    'keeps ordinary arguments outside the shell-wrapper model: %s',
    async (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(
        await manager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
          toolName: 'run_shell_command',
          command,
        }),
      ).toBe('allow');
    },
  );

  it.each(['run_shell_command', 'monitor'])(
    'keeps cwd restrictions conservative for %s',
    async (toolName) => {
      for (const prefix of [
        'cd /tmp <<< x',
        'a+=1 cd /tmp',
        'a[0]=1 cd /tmp',
        'f(){ cd /tmp; }; f',
        'source ./change-dir.sh',
        '. ./change-dir.sh',
      ]) {
        const command = `${prefix} && git >protected push origin main`;
        const pm = manager(['Bash(*)'], ['Bash(git>/tmp/protected push *)']);
        const ctx = { toolName, command, cwd: '/project' };
        expect(pm.hasRelevantRules(ctx)).toBe(true);
        expect(await evaluatePermissionRules(pm, 'allow', ctx)).toEqual({
          finalPermission: 'ask',
          pmForcedAsk: true,
        });
        expect(pm.findMatchingDenyRule(ctx)).toBeUndefined();
      }
    },
  );

  it.each(['protected', 'logs/x'])(
    'joins relative redirect %s at the root cwd',
    async (target) => {
      const command = `git >${target} push origin main`;
      const rule = `Bash(git >/${target === 'protected' ? target : 'logs/*'} push *)`;
      const pm = manager(['Bash(*)'], [rule], '/');
      const ctx = { toolName: 'run_shell_command', command, cwd: '/' };
      expect(await pm.evaluate(ctx)).toBe('deny');
      expect(pm.findMatchingDenyRule(ctx)).toBe(rule);
    },
  );

  it.each(['sudo', 'exec', 'env -i', 'command'])(
    'keeps a continued %s wrapper visible to the tracker',
    async (prefix) => {
      const command = `${prefix} \\\n bash -c 'git push > /tmp/protected'`;
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual([
        { virtualTool: 'write_file', filePath: '/tmp/protected' },
      ]);
      for (const toolName of ['run_shell_command', 'monitor']) {
        expect(
          await manager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
            toolName,
            command,
          }),
        ).toBe('deny');
      }
    },
  );
});
