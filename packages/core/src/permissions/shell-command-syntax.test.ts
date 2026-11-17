/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
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
    'git >/tmp//protected push origin main',
    'git >/tmp/./protected push origin main',
    'git >"/tmp//./protected" push origin main',
    'git >/tmp/prot"ected" push origin main',
    'git >&/tmp/protected push origin main',
    'git 1>&/tmp/protected push origin main',
    'git 2>&1>/tmp/protected push origin main',
    'git 2>& 1>/tmp/protected push origin main',
    'git >&-push origin main >/tmp/protected',
    'git <&-push origin main >/tmp/protected',
  ])('shares one word/write representation for %j', (command) => {
    expect(staticShellCommand(command)).toEqual(
      staticShellCommand('git >/tmp/protected push origin main'),
    );
  });

  it.each([
    ['protected', '/tmp/protected'],
    ['./protected', '/tmp/protected'],
    ['logs//./protected', '/tmp/logs/protected'],
    ["'~root'/./protected", '/tmp/~root/protected'],
    ['../protected', '/tmp/../protected'],
  ])(
    'resolves the static target %s only from a supplied cwd',
    (target, path) => {
      expect(staticShellCommand(`git >${target} push`, false, '/tmp')).toEqual(
        staticShellCommand(`git >${path} push`),
      );
      expect(staticShellCommand(`git >${target} push`)).not.toEqual(
        staticShellCommand(`git >${path} push`),
      );
    },
  );

  it('preserves wildcard metadata while resolving relative redirect patterns', () => {
    expect(staticShellCommand('git >logs/* push', true, '/tmp')).toEqual(
      staticShellCommand('git >/tmp/logs/* push', true),
    );
    expect(staticShellCommand("git >'logs/*' push", true, '/tmp')).toEqual(
      staticShellCommand("git >'/tmp/logs/*' push", true),
    );
    expect(staticShellCommand('git >*/protected push', true, '/tmp')).toEqual(
      staticShellCommand('git >*/protected push', true),
    );
    expect(
      staticShellCommand('git >logs/* push', false, '/tmp'),
    ).toBeUndefined();
  });

  it.each(['~', '~/protected', '~/logs/../protected', '~/logs//./protected'])(
    'expands a bare home target without collapsing parent traversal: %s',
    (target) => {
      const home = os.homedir().replace(/\\/g, '/');
      const absolute =
        target === '~' ? home : home.replace(/\/$/, '') + target.slice(1);
      const quoted = "'" + absolute.replaceAll("'", "'\\''") + "'";
      expect(staticShellCommand('git >' + target + ' push')).toEqual(
        staticShellCommand('git >' + quoted + ' push'),
      );
    },
  );

  it.each([
    '"~/protected"',
    "'~/protected'",
    '\\~/protected',
    "$'~/protected'",
    '~"/protected"',
    '""~/protected',
  ])('preserves a quoted tilde prefix as a literal: %s', (target) => {
    expect(staticShellCommand('git >' + target + ' push')).toEqual(
      staticShellCommand("git >'~/protected' push"),
    );
  });

  it.each([
    '>~"/protected">/tmp/log',
    '>~"/protected" >/tmp/log',
    '>""~/protected>/tmp/log',
    '>""~/protected >/tmp/log',
  ])(
    'keeps tilde quote metadata across adjacent redirects: %s',
    (redirects) => {
      expect(staticShellCommand('echo ' + redirects)).toEqual(
        staticShellCommand("echo >'~/protected' >/tmp/log"),
      );
    },
  );

  it('does not collapse parent traversal, double-slash roots, or named homes', () => {
    expect(staticShellCommand('git >/tmp/link/../protected push')).not.toEqual(
      staticShellCommand('git >/tmp/protected push'),
    );
    expect(staticShellCommand('git >//host/protected push')).not.toEqual(
      staticShellCommand('git >/host/protected push'),
    );
    expect(
      staticShellCommand('git >~root/protected push', false, '/tmp'),
    ).toBeUndefined();
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

  it.each(["''#x", '""#x', "$''#x", "'#x'", '\\#x'])(
    'retains a literal comment-looking word %s before a redirect',
    (word) => {
      const expected = staticShellCommand("git push '#x' >/tmp/protected");
      expect(expected?.redirects).toHaveLength(1);
      expect(staticShellCommand(`git push ${word} >/tmp/protected`)).toEqual(
        expected,
      );
    },
  );

  it.each([
    'env',
    'sudo',
    'doas',
    'time',
    'nice',
    'ionice',
    'nohup',
    'timeout 5',
    'unbuffer',
    'stdbuf',
    'env -u FOO',
    'env --unset=FOO',
    'nice -n 5',
    'nice --adjustment=5',
    '! env',
  ])('checks unresolved targets after the shared %s prefix', (prefix) => {
    expect(hasUnsupportedShellSyntax(`${prefix} bash -c 'git push > $X'`)).toBe(
      true,
    );
    expect(hasUnsupportedShellSyntax(`${prefix} bash -c 'git status'`)).toBe(
      false,
    );
  });

  it('does not read a prefix option value or an ordinary argument as a shell', () => {
    expect(hasUnsupportedShellSyntax("sudo -u bash echo 'git push > $X'")).toBe(
      false,
    );
    expect(hasUnsupportedShellSyntax("echo env bash -c 'git push > $X'")).toBe(
      false,
    );
    expect(hasUnsupportedShellSyntax("'!' env bash -c 'git push > $X'")).toBe(
      false,
    );
    expect(hasUnsupportedShellSyntax("\\! env bash -c 'git push > $X'")).toBe(
      false,
    );
  });

  it.each(['env -S', 'env --unknown', 'stdbuf -oL', 'sudo -s'])(
    'does not certify an unmodelled prefix option in %s',
    (prefix) => {
      expect(hasUnsupportedShellSyntax(`${prefix} bash -c 'git status'`)).toBe(
        true,
      );
      expect(
        hasUnsupportedShellSyntax(`${prefix} bash -c 'git push > $X'`),
      ).toBe(true);
    },
  );

  it('does not turn erroneous descriptor duplication into a file write', () => {
    expect(
      staticShellCommand('git 2>&/tmp/protected push origin'),
    ).toBeUndefined();
    expect(
      staticShellCommand('git <&/tmp/protected push origin'),
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
