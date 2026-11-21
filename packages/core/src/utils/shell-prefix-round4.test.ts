/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { extractShellOperationsAcrossCommand } from '../permissions/shell-semantics.js';
import {
  envSplitStringCommand,
  getMapfileCallback,
  getShellPrefixCommand,
} from './shell-command-prefixes.js';
import { stripShellCommandPrefixes } from './shell-utils.js';

const secret = '/tmp/qwen-prefix-probe/secret';
const output = '/tmp/qwen-prefix-probe/output';

async function inspect(command: string, deny = [`Read(/${secret})`]) {
  const pm = new PermissionManager({
    getPermissionsAllow: () => ['Bash(*)'],
    getPermissionsAsk: () => [],
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  pm.initialize();
  const ctx = { toolName: 'run_shell_command', command };
  return {
    operations: extractShellOperationsAcrossCommand(command, '/project'),
    decision: await pm.evaluate(ctx),
    integrated: await evaluatePermissionRules(pm, 'allow', ctx),
  };
}

async function expectRestrictedRead(command: string) {
  const result = await inspect(command);
  expect
    .soft(result.operations)
    .toContainEqual(
      expect.objectContaining({ virtualTool: 'read_file', filePath: secret }),
    );
  expect.soft(result.decision).toBe('deny');
  expect.soft(result.integrated.finalPermission).toBe('deny');
  expect.soft(stripShellCommandPrefixes(command)).toBeUndefined();
}

describe('portable env and timeout prefix inspection', () => {
  it.each([
    `env A=1 -S 'cat ${secret}'`,
    `env A=1 -Scat ${secret}`,
    `env A=1 --split-string 'cat ${secret}'`,
    `env A=1 --split-string='cat ${secret}'`,
    `env A=1 B=2 -S 'cat' ${secret}`,
  ])(
    'retains split-string payload after assignments: %s',
    expectRestrictedRead,
  );

  it.each(['\n', '\r\n'])(
    'retains the command after split-string comments under %j',
    async (eol) => {
      const payload = `# first${eol}# second${eol}cat ${secret}`;
      expect(envSplitStringCommand(payload, [])).toBe(
        `'env' 'cat' '${secret}'`,
      );
      await expectRestrictedRead(`env -S '${payload}'`);
    },
  );

  it.each([
    ['# comment to EOF', "'env'"],
    ['# comment\\nnot-a-newline', "'env'"],
    ['"#literal"', "'env' '#literal'"],
    ['\\#literal', "'env' '#literal'"],
    ['word#literal', "'env' 'word#literal'"],
    [
      'printf %s before #comment\nafter',
      "'env' 'printf' '%s' 'before' 'after'",
    ],
  ])('preserves env comment and literal boundaries: %j', (value, expected) => {
    expect(envSplitStringCommand(value, [])).toBe(expected);
  });

  it.each([
    { tokens: ['env', '--', 'A=1', '-S', 'cat'], commandIndex: 3 },
    { tokens: ['env', 'A=1', 'printf', '%s', '-S'], commandIndex: 2 },
    { tokens: ['env', '-u', 'IGNORED', 'A=1', 'cat', secret], commandIndex: 4 },
    { tokens: ['timeout', '--', '1', '--foreground', 'cat'], commandIndex: 3 },
    {
      tokens: ['timeout', '1', 'printf', '%s', '--foreground'],
      commandIndex: 2,
    },
    {
      tokens: ['timeout', '--foreground', '1', 'cat', secret],
      commandIndex: 3,
    },
    { tokens: ['timeout', '--', '1', 'cat', secret], commandIndex: 3 },
  ])(
    'stops options at the actual boundary: $tokens',
    ({ tokens, commandIndex }) => {
      expect(getShellPrefixCommand(tokens)).toEqual({
        commandIndex,
        hasUnsupportedOption: false,
      });
    },
  );

  it.each([
    `timeout 5 --foreground cat ${secret}`,
    `timeout 5 -- cat ${secret}`,
    `timeout 5 -s KILL cat ${secret}`,
    `timeout 5 -sKILL cat ${secret}`,
    `timeout 5 -v cat ${secret}`,
    `timeout -k 2 --preserve-status 5 --foreground cat ${secret}`,
  ])(
    'retains the command after post-duration options: %s',
    expectRestrictedRead,
  );

  it.each([
    ['env', '-C', '/tmp', 'cat', secret],
    ['env', '--chdir=/tmp', 'cat', secret],
    ['/usr/bin/time', '-o', output, 'cat', secret],
    ['/usr/bin/time', `--output=${output}`, 'cat', secret],
    ['/usr/bin/time', '-f', '%e', 'cat', secret],
    ['/usr/bin/time', '--format=%e', 'cat', secret],
    ['sudo', '-R', '/tmp', 'cat', secret],
    ['sudo', '--chroot=/tmp', 'cat', secret],
    ['sudo', '-h', 'example.invalid', 'cat', secret],
    ['sudo', '--host=example.invalid', 'cat', secret],
  ])(
    'consumes value-taking operands without granting transparency: %j',
    async (...tokens) => {
      expect.soft(getShellPrefixCommand(tokens)).toEqual({
        commandIndex: tokens.indexOf('cat'),
        hasUnsupportedOption: true,
      });
      await expectRestrictedRead(tokens.join(' '));
    },
  );

  it('keeps time output effects nontransparent even when its command is benign', async () => {
    const result = await inspect(`/usr/bin/time -o ${output} true`, [
      `Edit(/${output})`,
    ]);
    expect(result.decision).toBe('ask');
    expect(result.integrated).toEqual({
      finalPermission: 'ask',
      pmForcedAsk: true,
    });
  });

  it.each([
    `env A=1 cat ${secret}`,
    `env -u IGNORED cat ${secret}`,
    `timeout 5 cat ${secret}`,
    `timeout -k 2 --preserve-status 5 cat ${secret}`,
  ])('preserves existing restrictive command controls: %s', async (command) => {
    const result = await inspect(command);
    expect(result.operations).toContainEqual(
      expect.objectContaining({ virtualTool: 'read_file', filePath: secret }),
    );
    expect(result.decision).toBe('deny');
    expect(result.integrated.finalPermission).toBe('deny');
  });
});

describe('mapfile callback option parsing', () => {
  it.each(['mapfile', 'readarray'])(
    'finds attached and separate callbacks for %s',
    (command) => {
      expect(getMapfileCallback([command, '-C', 'cat file'])).toBe('cat file');
      expect(getMapfileCallback([command, '-tCcat file'])).toBe('cat file');
      expect(getMapfileCallback([command, '-t', '-C', ''])).toBe('');
      expect(getMapfileCallback([command, '-C', '--'])).toBe('--');
    },
  );

  it.each(['mapfile', 'readarray'])(
    'uses the last callback before the operand boundary for %s',
    (command) => {
      expect(
        getMapfileCallback([command, '-C', 'first', '-c', '1', '-Csecond']),
      ).toBe('second');
      expect(getMapfileCallback([command, '-Cfirst', '-C', ''])).toBe('');
      expect(
        getMapfileCallback([command, '-Cfirst', 'array', '-Csecond']),
      ).toBe('first');
      expect(getMapfileCallback([command, '-Cfirst', '--', '-Csecond'])).toBe(
        'first',
      );
      expect(getMapfileCallback([command, '-Cfirst', '-C'])).toBeUndefined();
    },
  );

  it.each(['d', 'n', 'O', 's', 'u', 'c'])(
    'consumes the complete value of -%s before looking for a callback',
    (flag) => {
      expect(
        getMapfileCallback(['mapfile', `-${flag}`, '--', '-C', 'cat file']),
      ).toBe('cat file');
      expect(
        getMapfileCallback(['mapfile', `-t${flag}C`, '-C', 'cat file']),
      ).toBe('cat file');
      expect(getMapfileCallback(['mapfile', `-${flag}`, '-C', 'array'])).toBe(
        undefined,
      );
      expect(
        getMapfileCallback(['mapfile', `-${flag}Ccat file`]),
      ).toBeUndefined();
    },
  );

  it.each([
    [],
    ['mapfile'],
    ['mapfile', '-C'],
    ['mapfile', '--', '-C', 'cat file'],
    ['mapfile', 'array', '-C', 'cat file'],
    ['mapfile', '-', '-C', 'cat file'],
    ['printf', '-C', 'cat file'],
    ['/bin/mapfile', '-C', 'cat file'],
  ])('does not invent a callback for %j', (...tokens) => {
    expect(getMapfileCallback(tokens)).toBeUndefined();
  });

  it('starts at the supplied command index without interpreting outer words', () => {
    const tokens = ['env', 'A=1', 'readarray', '-tc', '1', '-C', 'cat file'];
    expect(getMapfileCallback(tokens)).toBeUndefined();
    expect(getMapfileCallback(tokens, 2)).toBe('cat file');
    expect(getMapfileCallback(tokens, tokens.length)).toBeUndefined();
  });
});
