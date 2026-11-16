/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  maskConstantArithmetic,
  removeShellLineContinuations,
  staticShellCommand,
} from './shell-command-syntax.js';
import {
  hasUnsupportedShellSyntax,
  matchesRule,
  parseRule,
} from './rule-parser.js';

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

describe('Bash permission syntax views', () => {
  it.each([
    ['echo a\\\nb', 'echo ab'],
    ['echo "a\\\nb"', 'echo "ab"'],
    ["echo 'a\\\nb'", "echo 'a\\\nb'"],
    ["echo $'a\\\nb'", "echo $'a\\\nb'"],
    ["echo $\\\n'a\\\nb'", "echo $'a\\\nb'"],
    ['git >\\\n| /tmp/log pu\\\nsh origin', 'git >| /tmp/log push origin'],
    ["echo hi # ' \\\nnext", "echo hi # ' \\\nnext"],
  ])('joins only executable continuations in %j', (command, expected) => {
    expect(removeShellLineContinuations(command)).toBe(expected);
  });

  it.each([
    'echo "sum: $((1+2))"',
    'git push origin main-$((1+2))',
    'echo $((-(12 + 3) * 4 / 2 % 5))',
    'echo $(((1 + 2) * (3 - 1)))',
  ])('permits a fully parsed constant arithmetic argument in %j', (command) => {
    const view = maskConstantArithmetic(command);
    expect(view).toHaveLength(command.length);
    expect(view).not.toContain('$((');
    expect(hasUnsupportedShellSyntax(command)).toBe(false);
    expect(
      matchesRule(parseRule('Bash(*)'), 'run_shell_command', command),
    ).toBe(true);
  });

  it.each([
    'echo "$(( $(printf 1) + 1 ))"',
    'echo "$((value))"',
    'echo "$((a[$(printf 0)]))"',
    'echo "$((1 + $(( $(printf 1) ))))"',
    'echo "$((1) )"',
    'echo "$((1 + ))"',
    'echo "$((01))"',
    'echo "$((16#ff))"',
    'echo "$((1 << 2))"',
  ])(
    'retains the substitution veto for dynamic or unsupported arithmetic %j',
    (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(
        matchesRule(parseRule('Bash(echo *)'), 'run_shell_command', command),
      ).toBe(false);
    },
  );

  it.each([
    'echo hi > $((1+2))',
    'echo hi > "$((1+2))"',
    'echo hi > pack*.json',
    'echo hi > pack?ge.json',
    'echo hi > pack[ae]ge.json',
    'echo hi > "$TARGET"',
    "bash -c 'echo hi>/tmp/evil'",
  ])(
    'does not hide an unresolved redirect target or wrapper in %j',
    (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(true);
      expect(
        matchesRule(parseRule('Bash(*)'), 'run_shell_command', command),
      ).toBe(false);
    },
  );

  it.each([
    "echo hi > 'pack*.json'",
    'echo hi > "pack?ge.json"',
    'echo hi > pack\\[ae\\]ge.json',
    "echo hi > $'pack*.json'",
  ])(
    'keeps literal quoted and escaped redirect targets visible in %j',
    (command) => {
      expect(hasUnsupportedShellSyntax(command)).toBe(false);
    },
  );

  it.each([
    'git 1>/tmp/protected push origin main',
    'git 1> /tmp/protected push origin main',
    "git > '/tmp/protected' push origin main",
    'git &>/tmp/protected push origin main',
    'git >|/tmp/protected push origin main',
    'git >/tmp/prot\\ected push origin main',
  ])('shares one word/write representation for %j', (command) => {
    expect(staticShellCommand(command)).toEqual(
      staticShellCommand('git >/tmp/protected push origin main'),
    );
  });

  it('removes assignments with quoted values but retains quoted command names', () => {
    const command = staticShellCommand('git>/tmp/protected push origin');
    expect(
      staticShellCommand(
        '! FOO="two words" BAR=2 git>/tmp/protected push origin',
      ),
    ).toEqual(command);
    expect(
      staticShellCommand('FOO=$BAR git>/tmp/protected push origin'),
    ).toEqual(command);
    expect(
      staticShellCommand('FOO="$BAR" git>/tmp/protected push origin'),
    ).toEqual(command);
    expect(
      staticShellCommand('"FOO=two words" git>/tmp/protected push origin'),
    ).not.toEqual(command);
  });

  it.each([
    "git >'/tmp/$literal' push origin",
    'git >/tmp/\\$literal push origin',
    'git >"/tmp/\\$literal" push origin',
    "git >$'/tmp/$literal' push origin",
  ])('retains static literal dollar metadata in %j', (command) => {
    expect(staticShellCommand(command)).toEqual(
      staticShellCommand("git >'/tmp/$literal' push origin"),
    );
    expect(staticShellCommand(command)).toBeDefined();
  });

  it.each([
    'git >/tmp/$literal push origin',
    'git >"/tmp/$literal" push origin',
    'git >"/tmp/`target`" push origin',
  ])('retains dynamic expansion metadata in %j', (command) => {
    expect(staticShellCommand(command)).toBeUndefined();
    expect(hasUnsupportedShellSyntax(command)).toBe(true);
  });

  it('ignores dynamic-looking comment text but retains an actual dynamic word', () => {
    const base = staticShellCommand("git >'/tmp/protected' push origin");
    expect(
      staticShellCommand("git >'/tmp/protected' push origin #$NOTE"),
    ).toEqual(base);
    expect(
      staticShellCommand("git >'/tmp/protected' push origin $NOTE"),
    ).toBeUndefined();
  });

  it('preserves literal word boundaries, targets, and read/write differences', () => {
    expect(staticShellCommand('git >"/tmp/a b" push "a b"')).not.toEqual(
      staticShellCommand('git >/tmp/a push a b'),
    );
    expect(staticShellCommand('git </tmp/protected push origin')).not.toEqual(
      staticShellCommand('git >/tmp/protected push origin'),
    );
    expect(staticShellCommand('git >"*" push', true)).not.toEqual(
      staticShellCommand('git >* push', true),
    );
  });

  it.each([
    'git >"$TARGET" push origin',
    'git >pack*.json push origin',
    'git push origin; rm -rf /',
    'git > >(target) push origin',
  ])('has no static semantic spelling for %j', (command) => {
    expect(staticShellCommand(command)).toBeUndefined();
  });
});
