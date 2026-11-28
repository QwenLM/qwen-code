/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestCommandRules } from './command-rule-suggestions.js';
import { PermissionManager } from './permission-manager.js';
import * as shellAstParser from '../utils/shellAstParser.js';
import {
  _resetParser,
  _setParserFailedForTesting,
} from '../utils/shellAstParser.js';
import { getShellConfiguration, splitCommands } from '../utils/shell-utils.js';

const makeManager = (
  allow: string[],
  deny: string[] = [],
  ask: string[] = [],
) => {
  const manager = new PermissionManager({
    getPermissionsAllow: () => JSON.parse(JSON.stringify(allow)) as string[],
    getPermissionsDeny: () => deny,
    getPermissionsAsk: () => ask,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  manager.initialize();
  return manager;
};

vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return {
    ...actual,
    getShellConfiguration: vi.fn(() => ({
      executable: '/bin/bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    })),
  };
});

afterEach(() => {
  vi.mocked(getShellConfiguration).mockReturnValue({
    executable: '/bin/bash',
    argsPrefix: ['-c'],
    shell: 'bash',
  });
});

describe.each([
  ['run_shell_command', 'Bash'],
  ['monitor', 'Monitor'],
] as const)('%s permission suggestions', (toolName, displayName) => {
  it.each(['time', 'timeout 5', 'env FOO=1', 'sudo', 'nice -n 5'])(
    'scopes a transparent %s prefix to its executable payload',
    async (prefix) => {
      const command = `${prefix} git push origin main`;
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules).toEqual([
        `${displayName}(git push *)`,
        `${displayName}(${command})`,
      ]);
      const manager = makeManager(permissionRules);
      expect(await manager.evaluate({ toolName, command })).toBe('allow');
      expect(
        await manager.evaluate({
          toolName,
          command: `${prefix} git reset --hard`,
        }),
      ).toBe('ask');
    },
  );

  it.each([
    ['git commit -m', 'git commit *'],
    ['echo', 'echo *'],
  ])(
    'requires confirmation for an empty quoted argument after %s',
    async (prefix, pattern) => {
      const manager = makeManager([`${displayName}(${pattern})`]);
      for (const empty of ['""', "''"]) {
        const command = `${prefix} ${empty}`;
        expect(await manager.evaluate({ toolName, command })).toBe('ask');
        expect(await suggestCommandRules(command, displayName)).toEqual({
          permissionRules: [],
        });
      }
      expect(
        await manager.evaluate({
          toolName,
          command: `${prefix} "message"`,
        }),
      ).toBe('allow');
    },
  );

  it.each([
    'git > /tmp/log push origin \\\nmain',
    'git > /tmp/log push origin "ma\\\n in"',
    'npm install && git <&- push origin main',
    'git > /dev/null push origin main',
  ])('round-trips caller-derived eligible commands for %s', async (command) => {
    const { permissionRules = [] } = await suggestCommandRules(
      command,
      displayName,
      splitCommands(command),
    );
    expect(permissionRules.length).toBeGreaterThan(0);
    expect(
      await makeManager(permissionRules).evaluate({ toolName, command }),
    ).toBe('allow');
    expect(
      await makeManager(permissionRules).evaluate({
        toolName,
        command: 'git reset --hard',
      }),
    ).not.toBe('allow');
  });

  it.each([
    '(cd e2e && npm run test:e2e)',
    '(git push origin main) > out',
    '(cd e2e && npm run test:e2e) && npm install',
    '{ cd e2e; npm run test:e2e; } && npm install',
    'cd /var/www && for f in *.log; do gzip -f "$f"; done',
    'npm install && git log $(date)',
  ])(
    'does not offer partial caller-derived coverage for %s',
    async (command) => {
      for (const eligible of [undefined, splitCommands(command)]) {
        expect(
          await suggestCommandRules(command, displayName, eligible),
        ).toEqual({
          permissionRules: [],
        });
      }
    },
  );

  it('does not broaden a partially selected compound statement', async () => {
    expect(
      await suggestCommandRules('(git status && npm install)', displayName, [
        'npm install)',
      ]),
    ).toEqual({ permissionRules: [] });
  });

  it.each([
    '*',
    '**',
    'ls -la && *',
    'cd build && **',
    '* --version',
    'ls -la && * --version',
    'cd build && ** --help',
  ])(
    'does not persist a blanket grant from a glob executable: %s',
    async (command) => {
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules.some((rule) => /\([*\s]*\)$/.test(rule))).toBe(
        false,
      );
      expect(
        await makeManager(permissionRules).evaluate({
          toolName,
          command: 'rm -rf ~/Downloads',
        }),
      ).toBe('ask');
    },
  );

  it.each([
    '[ -f package.json ] && npm test',
    'export FOO=1 && npm test',
    'npm test && for f in *; do echo $f; done',
    'for f in *; do echo $f; done; npm test',
    'npm test && cat <<EOF\nrm -rf /tmp/not-a-command\nEOF',
    'cat <<EOF\nrm -rf /tmp/not-a-command\nEOF\nnpm test',
  ])(
    'does not persist an incomplete set for unsupported statements in %s',
    async (command) => {
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules).toEqual([]);
      const manager = makeManager(permissionRules);
      expect(await manager.evaluate({ toolName, command })).not.toBe('allow');
      expect(await manager.evaluate({ toolName, command: 'echo secret' })).toBe(
        'ask',
      );
      expect(await manager.evaluate({ toolName, command: 'cat' })).toBe('ask');
      expect(
        await manager.evaluate({
          toolName,
          command: 'rm -rf /tmp/not-a-command',
        }),
      ).toBe('ask');
    },
  );

  it.each([
    [
      'git push origin main # && rm -rf ~/Downloads',
      displayName === 'Bash' ? [`${displayName}(git push *)`] : [],
    ],
    ['npm test\n# done', []],
    [
      "npm test # it's done && rm -rf ~/Downloads",
      [`${displayName}(npm test)`],
    ],
  ])(
    'does not turn comment contents into grants: %s',
    async (command, expected) => {
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules).toEqual(expected);
      const manager = makeManager(permissionRules);
      if (permissionRules.length > 0) {
        expect(await manager.evaluate({ toolName, command })).toBe('allow');
      }
      expect(
        await manager.evaluate({
          toolName,
          command: 'rm -rf ~/Downloads',
        }),
      ).toBe('ask');
    },
  );

  it('does not restore a comment fragment selected by a caller', async () => {
    expect(
      await suggestCommandRules(
        'git push origin main # && rm -rf ~/Downloads',
        displayName,
        ['rm -rf ~/Downloads'],
      ),
    ).toEqual({ permissionRules: [] });
  });

  it('keeps a caller-selected command when its trailing comment is removed', async () => {
    expect(
      await suggestCommandRules(
        'git push origin main # && rm -rf ~/Downloads',
        displayName,
        ['git push origin main #'],
      ),
    ).toEqual({ permissionRules: [`${displayName}(git push *)`] });
  });

  it.each(['cmd', 'powershell'] as const)(
    'keeps suggestions consistent with the %s matcher',
    async (shell) => {
      vi.mocked(getShellConfiguration).mockReturnValue({
        executable: shell === 'cmd' ? 'cmd.exe' : 'powershell.exe',
        argsPrefix: shell === 'cmd' ? ['/c'] : ['-Command'],
        shell,
      });
      const command = 'echo hi>out.txt';
      const suggested = await suggestCommandRules(command, displayName);
      expect(suggested.permissionRules?.length).toBeGreaterThan(0);
      expect(suggested).not.toHaveProperty('hideAlwaysAllow');
      expect(
        await makeManager(suggested.permissionRules ?? []).evaluate({
          toolName,
          command,
        }),
      ).toBe('allow');
    },
  );

  it.each([
    'npm install && git log $(date)',
    'git log $(date) && npm install',
    'npm install && git <&- show "*"',
  ])(
    'does not offer a persistent choice that leaves %s unapproved',
    async (command) => {
      const suggested = await suggestCommandRules(command, displayName);
      expect(suggested).toEqual({
        permissionRules: [],
      });
      expect(
        await makeManager(suggested.permissionRules ?? []).evaluate({
          toolName,
          command,
        }),
      ).not.toBe('allow');
    },
  );

  it('preserves the caller-selected confirmation scope', async () => {
    expect(
      await suggestCommandRules('npm install && git status', displayName, [
        'npm install',
      ]),
    ).toEqual({ permissionRules: [`${displayName}(npm install)`] });
  });

  it.each(['\n', '; ', ' # note\n'])(
    'keeps descriptor closes attached to their original statement across %j',
    async (separator) => {
      const command = `npm install <&-${separator}git <&- push origin main`;
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules).toContain(`${displayName}(npm install)`);
      expect(permissionRules).toContain(
        `${displayName}(git <&- push origin main)`,
      );
      expect(
        await makeManager(permissionRules).evaluate({ toolName, command }),
      ).toBe('allow');
      expect(
        await makeManager(permissionRules).evaluate({
          toolName,
          command: 'git reset --hard',
        }),
      ).toBe('ask');
    },
  );

  it('does not accept unrelated caller-selected fragments', async () => {
    expect(
      await suggestCommandRules('git status', displayName, ['npm install']),
    ).toEqual({ permissionRules: [] });
  });

  it.each([
    'for f in item; do echo $f; done',
    'cat <<EOF\nhello\nEOF',
    'git <<EOF > out 0<&3 push origin\nx\nEOF',
    'for f in item; do git <&- push origin; done',
    'npm install && git <&- <<EOF push\nx\nEOF',
    'npm install && cat <<EOF extra\nx\nEOF',
    'npm install && cat <<EOF\nmissing end',
    'npm install && git <&- push "unterminated',
  ])(
    'never treats control-flow or heredoc body fragments as commands: %s',
    async (command) => {
      expect(await suggestCommandRules(command, displayName)).toEqual({
        permissionRules: [],
      });
    },
  );

  it.each([
    'git > /tmp/log push origin \\\nmain',
    'git > /tmp/log push origin "ma\\\n in"',
    'git > /tmp/log push origin main-$((1+2))',
    'echo "sum: $((1+2))"',
    'git > /tmp/log push origin main',
    'git > ~/push.log push origin main',
    'git > /tmp/log push origin 中文',
    'git > /tmp/log push origin main # comment',
    'git >& file push origin main',
    'git &> /tmp/log push origin main',
    'git &>> /tmp/log push origin main',
    'npm install && git <&- push origin main',
    '! git > /tmp/log push origin main',
    'git>/tmp/protected push origin main',
    'git >file3>/tmp/protected push origin main',
  ])('reuses the rules offered for %s after reloading', async (command) => {
    const suggested = await suggestCommandRules(command, displayName);
    expect(suggested).not.toHaveProperty('hideAlwaysAllow');
    const manager = makeManager(suggested.permissionRules ?? []);
    expect(await manager.evaluate({ toolName, command })).toBe('allow');
    for (const other of ['git reset --hard', 'git clean -fdx']) {
      expect(await manager.evaluate({ toolName, command: other })).not.toBe(
        'allow',
      );
    }
  });

  it.each([
    'git > $LOG push origin main',
    'git > out/$X push origin main',
    'git >>$LOG push origin main',
    'git 3>/tmp/protected push origin main',
    'git 10>/tmp/protected push origin main',
    'git 01>/tmp/protected push origin main',
    'git 0</tmp/protected push origin main',
    'git <> /tmp/protected push origin main',
    'git <<EOF push origin main\ndata\nEOF',
    'for f in *; do echo $f; done',
    'git > *.log push origin main',
    'git <&- show "*"',
  ])('does not offer reusable rules for unsafe syntax: %s', async (command) => {
    const suggested = await suggestCommandRules(command, displayName);
    expect(suggested).toEqual({ permissionRules: [] });
    const manager = makeManager(suggested.permissionRules ?? [], [
      'Edit(//tmp/protected)',
    ]);
    expect(await manager.evaluate({ toolName, command })).not.toBe('allow');
    expect(
      await manager.evaluate({
        toolName,
        command: 'for f in /etc/passwd; do echo $f; done',
      }),
    ).not.toBe('allow');
  });

  it.each([
    '3>/tmp/protected',
    '10>/tmp/protected',
    '0</tmp/protected',
    '3</tmp/protected',
    String.raw`foo\ #not-comment 3>/tmp/protected`,
    String.raw`$'a\'b' 3>/tmp/protected`,
    "$\\\n'a\\'b' 3>/tmp/protected",
    "$\\\n\\\n'a\\'b' 3>/tmp/protected",
    String.raw`"$(echo example 3>/tmp/protected)"`,
    String.raw`foo\ #not-comment "$(echo example 3>/tmp/protected)"`,
    'foo\\ #not-comment "$\\\n(echo example 3>/tmp/protected)"',
  ])(
    'does not inherit a saved prefix grant after appending %s',
    async (suffix) => {
      const original = 'git > /tmp/log push origin main';
      const { permissionRules = [] } = await suggestCommandRules(
        original,
        displayName,
      );
      const command = `${original} ${suffix}`;
      const manager = makeManager(permissionRules, [
        'Edit(//tmp/protected)',
        'Read(//tmp/protected)',
      ]);
      expect(await manager.evaluate({ toolName, command: original })).toBe(
        'allow',
      );
      expect(await manager.evaluate({ toolName, command })).not.toBe('allow');
      for (const existing of [displayName, `${displayName}(git *)`]) {
        expect(
          await makeManager([existing]).evaluate({ toolName, command }),
        ).not.toBe('allow');
        expect(
          await makeManager(permissionRules, [existing]).evaluate({
            toolName,
            command,
          }),
        ).toBe('deny');
      }
    },
  );

  it.each([
    'junk>/tmp/protected',
    'junk</tmp/protected',
    String.raw`junk\ >/tmp/protected`,
    'junk\\\t>/tmp/protected',
    String.raw`junk\ 2>/tmp/protected`,
    '>file3>/tmp/protected',
    '2>&1>/tmp/protected',
  ])(
    'keeps file restrictions for an adjacent redirect after %s',
    async (suffix) => {
      const command = `git push origin main ${suffix}`;
      const allow = [`${displayName}(git *)`];
      expect(await makeManager(allow).evaluate({ toolName, command })).toBe(
        'allow',
      );
      expect(
        await makeManager(allow, [
          'Edit(//tmp/protected)',
          'Read(//tmp/protected)',
        ]).evaluate({ toolName, command }),
      ).not.toBe('allow');
    },
  );

  it.each([
    '--verbose',
    '"3>/tmp/protected"',
    "'junk</tmp/protected'",
    'junk\\>/tmp/protected',
    'junk\\</tmp/protected',
    '# 3>/tmp/protected',
    String.raw`$'a\'b 3>/tmp/protected'`,
    "$\\\n'a\\'b 3>/tmp/protected'",
    "$\\\n\\\n'a\\'b 3>/tmp/protected'",
  ])(
    'retains ordinary prefix arguments and literal operators: %s',
    async (suffix) => {
      const original = 'git > /tmp/log push origin main';
      const { permissionRules = [] } = await suggestCommandRules(
        original,
        displayName,
      );
      const command = `${original} ${suffix}`;
      expect(
        await makeManager(permissionRules, [
          'Edit(//tmp/protected)',
          'Read(//tmp/protected)',
        ]).evaluate({ toolName, command }),
      ).toBe('allow');
    },
  );

  it.each([
    'git>/tmp/protected push *',
    'git> /tmp/protected push *',
    'git >/tmp/protected push *',
    'git > /tmp/protected push *',
    'git> * push *',
    'git > * push *',
    'git>* push *',
  ])(
    'keeps restrictive rule %s ahead of a persisted raw fallback',
    async (pattern) => {
      const rule = `${displayName}(${pattern})`;
      for (const command of [
        'git >/tmp/protected push origin main',
        'git > /tmp/protected push origin main',
        '! FOO=1 git >/tmp/protected push origin main',
      ]) {
        const { permissionRules = [] } = await suggestCommandRules(
          command,
          displayName,
        );
        const denied = makeManager(permissionRules, [rule]);
        expect(await denied.evaluate({ toolName, command })).toBe('deny');
        expect(denied.findMatchingDenyRule({ toolName, command })).toBe(rule);
        const asked = makeManager(permissionRules, [], [rule]);
        expect(await asked.evaluate({ toolName, command })).toBe('ask');
        expect(asked.hasMatchingAskRule({ toolName, command })).toBe(true);
      }
    },
  );

  it('retains prefix semantics for a non-wildcard npm rule', async () => {
    const command = 'npm > /tmp/log install';
    const { permissionRules = [] } = await suggestCommandRules(
      command,
      displayName,
    );
    expect(permissionRules).toContain(`${displayName}(npm install)`);
    const manager = makeManager(permissionRules);
    expect(await manager.evaluate({ toolName, command })).toBe('allow');
    expect(
      await manager.evaluate({ toolName, command: 'npm install express' }),
    ).toBe('allow');
    expect(
      await manager.evaluate({ toolName, command: 'npm run test' }),
    ).not.toBe('allow');
  });

  it('falls back separately for every command when the parser fails', async () => {
    _setParserFailedForTesting();
    try {
      const command = 'npm install && tail -f /tmp/log';
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules).toEqual([
        `${displayName}(npm install)`,
        `${displayName}(tail -f /tmp/log)`,
      ]);
      expect(
        await makeManager(permissionRules).evaluate({ toolName, command }),
      ).toBe('allow');
    } finally {
      _resetParser();
    }
  });

  it.each([
    'for f in item; do echo $f; done',
    'cat <<EOF\nhello\nEOF',
    'if true; then echo safe; fi',
  ])(
    'does not derive complex rules without the parser: %s',
    async (command) => {
      _setParserFailedForTesting();
      try {
        expect(await suggestCommandRules(command, displayName)).toEqual({
          permissionRules: [],
        });
      } finally {
        _resetParser();
      }
    },
  );

  it('retains successful rules and falls back after an extraction exception', async () => {
    const extract = vi.spyOn(shellAstParser, 'extractCommandRules');
    extract
      .mockResolvedValueOnce(['npm install'])
      .mockRejectedValueOnce(new Error('parser unavailable'));
    try {
      const command = 'npm install && git <&- push origin main';
      const { permissionRules = [] } = await suggestCommandRules(
        command,
        displayName,
      );
      expect(permissionRules).toEqual([
        `${displayName}(npm install)`,
        `${displayName}(git <&- push origin main)`,
      ]);
      expect(
        await makeManager(permissionRules).evaluate({ toolName, command }),
      ).toBe('allow');
    } finally {
      extract.mockRestore();
    }
  });
});
