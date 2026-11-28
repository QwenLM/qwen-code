/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { PermissionManager } from './permission-manager.js';
import { hasUnsupportedShellSyntax } from './rule-parser.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';
import { MAX_SHELL_UNWRAP_DEPTH } from '../utils/shell-command-prefixes.js';

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

function makeManager(allow: string[], deny: string[] = []) {
  const manager = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => [],
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  manager.initialize();
  return manager;
}

const prefixes = [
  'exec',
  'command',
  'setsid',
  '/usr/bin/setsid',
  '/usr/bin/sudo',
  'command /usr/bin/setsid',
  'sudo -n',
  'env -i',
  'time -p',
  'nice -5',
  'timeout --foreground 5',
];

describe.each(['run_shell_command', 'monitor'])(
  '%s execution-wrapper permissions',
  (toolName) => {
    const ruleTool = toolName === 'monitor' ? 'Monitor' : 'Bash';

    it.each(['FOO=$((1+2))#', 'FOO=1'])(
      'does not let an assignment suffix hide a dynamic shell write: %s',
      async (assignment) => {
        const command = `env ${assignment} bash -c 'git push > $X'`;
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await makeManager(['Bash(env *)']).evaluate({ toolName, command }),
        ).toBe('ask');
      },
    );

    it.each(prefixes)(
      'retains an exact persistent grant for %s git status',
      async (prefix) => {
        const command = `${prefix} git status`;
        expect(hasUnsupportedShellSyntax(command)).toBe(false);
        expect(
          await makeManager([`${ruleTool}(${command})`]).evaluate({
            toolName,
            command,
          }),
        ).toBe('allow');
      },
    );

    it.each(prefixes)(
      'tracks a static protected write through %s',
      async (prefix) => {
        const command = `${prefix} bash -c 'echo hi > /tmp/protected'`;
        expect(hasUnsupportedShellSyntax(command)).toBe(false);
        expect(
          extractShellOperationsAcrossCommand(command, '/project'),
        ).toEqual([{ virtualTool: 'write_file', filePath: '/tmp/protected' }]);
        expect(
          await makeManager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
            toolName,
            command,
          }),
        ).toBe('deny');
      },
    );

    it.each(prefixes)(
      'keeps an unresolved write behind %s on the ask path',
      async (prefix) => {
        const command = `${prefix} bash -c 'git push > $X'`;
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await makeManager([`${ruleTool}(${command})`]).evaluate({
            toolName,
            command,
          }),
        ).toBe('ask');
      },
    );

    it.each([
      "eval 'git push > $X'",
      "eval 'echo hi > /tmp/protected'",
      "builtin eval 'echo hi > /tmp/protected'",
      "xargs bash -c 'echo hi > /tmp/protected'",
      "(bash -c 'echo hi > /tmp/protected')",
      "{ bash -c 'echo hi > /tmp/protected'; }",
      "if true; then bash -c 'echo hi > /tmp/protected'; fi",
    ])('does not certify an unmodelled execution form: %s', async (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(
        await makeManager(['Bash(*)']).evaluate({ toolName, command }),
      ).toBe('ask');
    });

    it.each([
      "exec >/tmp/log bash -c 'echo hi > /tmp/protected'",
      ">/tmp/log bash -c 'echo hi > /tmp/protected'",
      "exec bash >/tmp/log -c 'echo hi > /tmp/protected'",
    ])(
      'asks when redirection hides the shell payload from the tracker: %s',
      async (command) => {
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await makeManager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
            toolName,
            command,
          }),
        ).toBe('ask');
      },
    );

    it.each(['~root/.bashrc', '~+/.bashrc', '~-/.bashrc'])(
      'does not resolve an unsupported tilde redirect as a literal path: %s',
      async (target) => {
        const command = `echo hi > ${target}`;
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await makeManager(['Bash(*)'], ['Edit(//root/.bashrc)']).evaluate({
            toolName,
            command,
          }),
        ).toBe('ask');
      },
    );

    it.each(['-D /tmp', '-D/tmp', '--chdir /tmp', '--chdir=/tmp'])(
      'does not resolve a sudo %s payload against the original cwd',
      async (option) => {
        const command = `sudo ${option} bash -c 'echo hi > protected'`;
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await makeManager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
            toolName,
            command,
          }),
        ).toBe('ask');
      },
    );

    it.each([
      "echo env bash -c 'git push > $X'",
      "echo /usr/bin/setsid bash -c 'echo hi > /tmp/protected'",
      "exec echo 'hi > /tmp/protected'",
      "command echo 'hi > /tmp/protected'",
      "setsid echo 'hi > /tmp/protected'",
      "exec -a bash echo 'git push > $X'",
      '>/tmp/log git status',
      'exec >/tmp/log git status',
      "echo hi > '~root/.bashrc'",
      'echo hi > ~"root"/.bashrc',
      'echo hi > \\~root/.bashrc',
    ])('preserves non-executing literal arguments in %s', async (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(
        await makeManager(
          ['Bash(*)'],
          ['Edit(//tmp/protected)', 'Edit(//root/.bashrc)'],
        ).evaluate({ toolName, command }),
      ).toBe('allow');
    });

    it.each(['bash', 'sudo bash'])(
      'preserves the existing static protected-write denial for %s',
      async (prefix) => {
        const command = `${prefix} -c 'echo hi > /tmp/protected'`;
        expect(hasUnsupportedShellSyntax(command)).toBe(false);
        expect(
          await makeManager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
            toolName,
            command,
          }),
        ).toBe('deny');
      },
    );

    it('preserves a protected outer redirect when unwrapping a shell payload', async () => {
      const command = "exec bash -c 'echo hi' > /tmp/protected";
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(
        await makeManager(['Bash(*)'], ['Edit(//tmp/protected)']).evaluate({
          toolName,
          command,
        }),
      ).toBe('deny');
    });

    it('retains the shell payload depth cap through transparent prefixes', async () => {
      let command = 'git status';
      for (let depth = 0; depth <= MAX_SHELL_UNWRAP_DEPTH; depth++) {
        command = `exec bash -c '${command.replaceAll("'", "'\\''")}'`;
      }
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(
        await makeManager(['Bash(*)']).evaluate({ toolName, command }),
      ).toBe('ask');
    });
  },
);
