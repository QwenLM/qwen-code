/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { suggestCommandRules } from './command-rule-suggestions.js';
import { PermissionManager } from './permission-manager.js';
import * as shellAstParser from '../utils/shellAstParser.js';
import {
  _resetParser,
  _setParserFailedForTesting,
} from '../utils/shellAstParser.js';
import { splitCommands } from '../utils/shell-utils.js';

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
    getShellConfiguration: () => ({
      executable: '/bin/bash',
      argsPrefix: ['-c'],
      shell: 'bash',
    }),
  };
});

describe.each([
  ['run_shell_command', 'Bash'],
  ['monitor', 'Monitor'],
] as const)('%s permission suggestions', (toolName, displayName) => {
  it.each([
    'git > /tmp/log push origin main',
    'git > $LOG push origin main',
    'git > ~/push.log push origin main',
    'git > out/$X push origin main',
    'git >>$LOG push origin main',
    'git > /tmp/log push origin 中文',
    'git > /tmp/log push origin main # comment',
    '(git push origin main) > out',
    'git >& file push origin main',
    'git &> /tmp/log push origin main',
    'git &>> /tmp/log push origin main',
    'npm install && git <&- push origin main',
    '! git > /tmp/log push origin main',
  ])('reuses the rules offered for %s after reloading', async (command) => {
    const suggested = await suggestCommandRules(
      splitCommands(command),
      displayName,
    );
    expect(suggested.hideAlwaysAllow).not.toBe(true);
    const manager = makeManager(suggested.permissionRules ?? []);
    expect(await manager.evaluate({ toolName, command })).toBe('allow');
    for (const other of ['git reset --hard', 'git clean -fdx']) {
      expect(await manager.evaluate({ toolName, command: other })).not.toBe(
        'allow',
      );
    }
  });

  it.each([
    'git 3>/tmp/protected push origin main',
    'git 10>/tmp/protected push origin main',
    'git 01>/tmp/protected push origin main',
    'git>/tmp/protected push origin main',
    'git 0</tmp/protected push origin main',
    'git <> /tmp/protected push origin main',
    'git >file3>/tmp/protected push origin main',
    'git <<EOF push origin main\ndata\nEOF',
    'for f in *; do echo $f; done',
    'git > *.log push origin main',
    'git <&- show "*"',
  ])(
    'offers only single-use approval when a reusable rule is unsafe: %s',
    async (command) => {
      const suggested = await suggestCommandRules(
        splitCommands(command),
        displayName,
      );
      expect(suggested).toEqual({ permissionRules: [], hideAlwaysAllow: true });
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
    },
  );

  it.each([
    '3>/tmp/protected',
    '10>/tmp/protected',
    'junk>/tmp/protected',
    '0</tmp/protected',
    '3</tmp/protected',
    'junk</tmp/protected',
    String.raw`junk\ >/tmp/protected`,
    String.raw`foo\ #not-comment 3>/tmp/protected`,
    'junk\\\t>/tmp/protected',
    String.raw`junk\ 2>/tmp/protected`,
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
        [original],
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
        [original],
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
          [command],
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
      [command],
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
        splitCommands(command),
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

  it('retains successful rules and falls back after an extraction exception', async () => {
    const extract = vi.spyOn(shellAstParser, 'extractCommandRules');
    extract
      .mockResolvedValueOnce(['npm install'])
      .mockRejectedValueOnce(new Error('parser unavailable'));
    try {
      const command = 'npm install && git <&- push origin main';
      const { permissionRules = [] } = await suggestCommandRules(
        splitCommands(command),
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
