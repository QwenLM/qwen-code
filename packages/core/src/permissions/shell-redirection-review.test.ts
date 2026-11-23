/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { suggestCommandRules } from './command-rule-suggestions.js';
import { PermissionManager } from './permission-manager.js';
import { hasUnsupportedShellSyntax } from './rule-parser.js';

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

function manager(allow: string[], deny: string[] = []) {
  const pm = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsDeny: () => deny,
    getPermissionsAsk: () => [],
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  pm.initialize();
  return pm;
}

describe('reviewed shell redirection boundaries', () => {
  it.each([
    '> /dev/null xargs -I {} rm {}',
    '> /dev/null eval "$PAYLOAD"',
    '> /dev/null source "$SCRIPT"',
    '> /dev/null . "$SCRIPT"',
    '> /dev/null trap "$PAYLOAD" EXIT',
    '> /dev/null fn() { echo marker; }',
    '> /dev/null env MODE=test find . -exec echo {} \\;',
    'env MODE=test > /dev/null find . -exec echo {} \\;',
    'echo marker>out;>/dev/null find . -exec echo {} \\;',
    'echo marker>out&&>/dev/null find . -exec echo {} \\;',
    'echo marker>out|>/dev/null find . -exec echo {} \\;',
    "echo marker>out # quoted comment '\n>/dev/null find . -exec echo {} \\;",
    ">$'output\\' file' find . -exec echo {} \\;",
    '>"output file">other find . -exec echo {} \\;',
  ])(
    'retains executable syntax after removing redirects: %s',
    async (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      for (const toolName of ['run_shell_command', 'monitor']) {
        expect(await manager(['Bash(*)']).evaluate({ toolName, command })).toBe(
          'ask',
        );
      }
    },
  );

  it.each([
    '> /dev/null',
    '>/dev/null',
    '2>/dev/null',
    '>out',
    '&>/dev/null',
    '< /dev/null',
  ])(
    'retains the find execution veto after a leading redirect: %s',
    async (prefix) => {
      const plain = 'find . -exec rm -rf {} \\;';
      const command = `${prefix} ${plain}`;
      expect(hasUnsupportedShellSyntax(plain)).toBe(true);
      expect.soft(hasUnsupportedShellSyntax(command)).toBe(true);
      for (const toolName of ['run_shell_command', 'monitor']) {
        const pm = manager(['Bash(*)']);
        expect(await pm.evaluate({ toolName, command: plain })).toBe('ask');
        expect.soft(await pm.evaluate({ toolName, command })).toBe('ask');
      }
    },
  );

  it('retains restrictive command rules for a redirected callback', async () => {
    const command = '> /dev/null find . -exec rm -rf {} \\;';
    const pm = manager(['Bash(find *)'], ['Bash(rm -rf *)']);
    expect(await pm.evaluate({ toolName: 'run_shell_command', command })).toBe(
      'ask',
    );
  });

  it.each([
    ['npm test>/dev/null 2>&1', 'npm test >/dev/null 2>&1', 'Bash(npm *)'],
    ['git log --oneline>/tmp/x', 'git log --oneline >/tmp/x', 'Bash(git *)'],
    ['make>/tmp/build.log', 'make >/tmp/build.log', 'Bash(make *)'],
    ['ls -la>/tmp/o', 'ls -la >/tmp/o', 'Bash(ls *)'],
    [
      "printf '%s' marker>'/tmp/output file'",
      "printf '%s' marker >'/tmp/output file'",
      'Bash(printf *)',
    ],
  ])(
    'accepts a redirect adjacent to a completed argument: %s',
    async (command, spaced, rule) => {
      expect(hasUnsupportedShellSyntax(spaced)).toBe(false);
      expect.soft(hasUnsupportedShellSyntax(command)).toBe(false);
      const pm = manager([rule]);
      expect(
        await pm.evaluate({ toolName: 'run_shell_command', command: spaced }),
      ).toBe('allow');
      expect
        .soft(await pm.evaluate({ toolName: 'run_shell_command', command }))
        .toBe('allow');
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        'Bash',
      );
      expect.soft(permissionRules.length).toBeGreaterThan(0);
      expect(
        await manager(permissionRules).evaluate({
          toolName: 'run_shell_command',
          command,
        }),
      ).toBe('allow');
    },
  );

  it.each(['npm test>$OUTPUT', 'npm test>$(printf output)', 'npm test>*.log'])(
    'keeps unresolved adjacent redirect targets conservative: %s',
    (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
    },
  );

  it.each([
    '> /dev/null echo "$VALUE"',
    '>"output file" printf "%s" "{}"',
    'echo marker3>/tmp/out',
    "echo '3'>/tmp/out",
    'echo \\3>/tmp/out',
    'echo marker>out; echo next>other',
    'echo marker>out && echo next>other',
  ])(
    'keeps ordinary executable words and argument boundaries: %s',
    async (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
      expect(
        await manager(['Bash(*)']).evaluate({
          toolName: 'run_shell_command',
          command,
        }),
      ).toBe('allow');
    },
  );

  it.each([
    'echo marker 3>/tmp/out',
    'echo marker 10>/tmp/out',
    'echo marker 01>/tmp/out',
    'cat 0</tmp/in',
    'cat <>/tmp/in',
    'cat <<EOF\nmarker\nEOF',
    'echo marker {fd}>/tmp/out',
    'echo "$VALUE">/tmp/out',
  ])(
    'does not widen unsupported descriptors or expanded words: %s',
    (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
    },
  );

  it.each([
    'echo marker>/tmp/protected',
    'cat</tmp/protected',
    'echo marker>other>/tmp/protected',
  ])(
    'keeps adjacent file effects subject to explicit restrictions: %s',
    async (command) => {
      for (const toolName of ['run_shell_command', 'monitor']) {
        expect(
          await manager(
            ['Bash(*)'],
            ['Edit(//tmp/protected)', 'Read(//tmp/protected)'],
          ).evaluate({ toolName, command }),
        ).not.toBe('allow');
      }
    },
  );
});
