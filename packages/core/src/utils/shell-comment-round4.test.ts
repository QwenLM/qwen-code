/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { removeShellLineContinuations } from '../permissions/shell-command-syntax.js';
import {
  buildShellExecWarnings,
  checkCommandPermissions,
  COMMAND_SUBSTITUTION_WARNING,
  detectCommandSubstitution,
  isCommandAllowed,
} from './shell-utils.js';

const config = {
  getCoreTools: () => [],
  getPermissionsDeny: () => [],
  getPermissionsAllow: () => [],
} as unknown as Config;

describe('comments after closing parentheses', () => {
  it.each([
    "(true)#'\ncat $(printf /tmp/protected)",
    '(true)#"\nprintf "%s\\n" "$(printf EXECUTED)"',
    "( (true) )#'\nprintf '%s\\n' $(printf EXECUTED)",
  ])(
    'hard-denies substitution after a group comment in %s',
    async (command) => {
      expect(detectCommandSubstitution(command)).toBe(true);
      expect(buildShellExecWarnings(command, command)).toEqual([
        COMMAND_SUBSTITUTION_WARNING,
      ]);
      expect(await checkCommandPermissions(command, config)).toMatchObject({
        allAllowed: false,
        isHardDenial: true,
        blockReason: expect.stringContaining('Command substitution'),
      });
      expect(await isCommandAllowed(command, config)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining('Command substitution'),
      });
    },
  );

  it.each([
    '(true)# rebuild $(printf ignored)',
    '( (true) )# rebuild $(printf ignored)',
    '(true)# rebuild `printf ignored`',
  ])(
    'ignores substitution text inside a group comment in %s',
    async (command) => {
      expect(detectCommandSubstitution(command)).toBe(false);
      expect(buildShellExecWarnings(command, command)).toBeUndefined();
      expect((await isCommandAllowed(command, config)).allowed).toBe(true);
    },
  );

  it('preserves the physical newline of a group comment', () => {
    const command = '(true)#\\\nprintf safe';
    expect(removeShellLineContinuations(command)).toBe(command);
  });

  it.each([
    'echo $(id)#',
    'echo $( (printf x) )#',
    'echo $(printf %s $(printf x)#y)#',
    'echo $\\\n(printf x)#',
    'echo $((1 + 2))#',
    'echo <(printf x)#',
    'echo >(printf x)#',
    'echo <\\\n(printf x)#',
    'echo ${value:-fallback}#',
    'echo $(printf %s ${value:-)})#',
    'echo `printf x`#',
    'echo foo#',
    'echo \\)#',
    "echo ')'#",
  ])('keeps a hash in the same shell word after %s', (prefix) => {
    expect(removeShellLineContinuations(`${prefix}\\\ny`)).toBe(
      `${prefix.replaceAll('\\\n', '')}y`,
    );
  });

  it.each([
    'echo foo#$(printf EXECUTED)',
    'echo ${value:-fallback}#$(printf EXECUTED)',
    'echo $(printf x)#$(printf EXECUTED)',
  ])('still detects substitution following a literal hash in %s', (command) => {
    expect(detectCommandSubstitution(command)).toBe(true);
  });
});
