/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PermissionManager } from './permission-manager.js';
import {
  evaluatePermissionRules,
  persistPermissionOutcome,
} from '../core/permission-helpers.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { suggestCommandRules } from './command-rule-suggestions.js';
import {
  hasUnsupportedShellSyntax,
  matchesCommandPattern,
} from './rule-parser.js';

const shellType = vi.hoisted(() => ({
  value: 'bash' as 'bash' | 'cmd' | 'powershell',
}));
beforeEach(() => {
  shellType.value = 'bash';
});

vi.mock('../utils/shell-utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/shell-utils.js')>();
  return {
    ...actual,
    getShellConfiguration: () => ({
      ...actual.getShellConfiguration(),
      shell: shellType.value,
    }),
  };
});

const pushRule = 'Bash(git push *)';
const makeManager = (
  allow: string[] = [pushRule],
  ask: string[] = [],
  deny: string[] = [],
  cwd = '/project',
) => {
  const manager = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => ask,
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/project',
    getCwd: () => cwd,
    getShellExecutionSandbox: () => true,
  });
  manager.initialize();
  return manager;
};

describe.each(['run_shell_command', 'monitor'])(
  '%s redirected command permissions',
  (toolName) => {
    it.each([
      'git >> /dev/null push origin main',
      'git &> /dev/null push origin main',
      'git &>> /dev/null push origin main',
      'git 2> /dev/null push origin main',
      'git >| /dev/null push origin main',
      'git 2>&1 push origin main',
      '>/dev/null git push origin main',
      'git > "/tmp/output file" push origin main',
      'git > /dev/null push > /tmp/output origin main',
      'FOO=1 git > /dev/null push origin main',
    ])(
      'does not widen an existing push grant through a redirect: %j',
      async (command) => {
        expect(
          await evaluatePermissionRules(makeManager(), 'ask', {
            toolName,
            command,
          }),
        ).toEqual({ finalPermission: 'ask', pmForcedAsk: false });
      },
    );

    it.each([
      'git > /dev/null push origin main',
      '! git > /dev/null push origin main',
      'git status && git > /dev/null push origin main',
      'git status | git > /dev/null push origin main',
    ])('reuses persisted subcommand rules for %j', async (command) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-rule-'));
      onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
      const settingsPath = path.join(directory, 'settings.json');
      const settings = { permissions: { allow: [] as string[] } };
      const suggested = await suggestCommandRules(
        command,
        toolName === 'monitor' ? 'Monitor' : 'Bash',
      );
      const rules = suggested.permissionRules ?? [];
      expect(suggested).not.toHaveProperty('hideAlwaysAllow', true);
      expect(rules).toContain(
        `${toolName === 'monitor' ? 'Monitor' : 'Bash'}(git push *)`,
      );
      const manager = makeManager([]);
      const ctx = { toolName, command };
      expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
        finalPermission: 'ask',
        pmForcedAsk: false,
      });
      await persistPermissionOutcome(
        ToolConfirmationOutcome.ProceedAlwaysUser,
        {
          type: 'exec',
          title: 'Confirm command',
          command,
          rootCommand: 'git',
          permissionRules: rules,
          onConfirm: async () => {},
        },
        async (scope, ruleType, rule) => {
          expect(scope).toBe('user');
          expect(ruleType).toBe('allow');
          settings.permissions.allow.push(rule);
          await fs.writeFile(settingsPath, JSON.stringify(settings));
        },
        manager,
      );
      const reloaded = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
        permissions: { allow: string[] };
      };
      expect(reloaded.permissions.allow).toEqual(rules);
      for (const current of [
        manager,
        makeManager(reloaded.permissions.allow),
      ]) {
        expect(current.hasRelevantRules(ctx)).toBe(true);
        expect(await evaluatePermissionRules(current, 'ask', ctx)).toEqual({
          finalPermission: 'allow',
          pmForcedAsk: false,
        });
        for (const other of ['reset --hard', 'clean -fdx']) {
          expect(
            await evaluatePermissionRules(current, 'ask', {
              ...ctx,
              command: command.replace('push origin main', other),
            }),
          ).toMatchObject({ finalPermission: 'ask' });
        }
      }
    });

    it.each([
      'git > "$(other-command)" push origin main',
      'git > `other-command` push origin main',
      'git > >(other-command) push origin main',
      'git < <(other-command) push origin main',
      'git <<< "$(other-command)" push origin main',
      'git <<EOF push origin main\n$(other-command)\nEOF',
      "git '>' /dev/null push origin main",
      'git 0 < /dev/null push origin main',
      "git '0'< /dev/null push origin main",
      "'FOO'=1 > /dev/null git push origin main",
      '"FOO=1" > /dev/null git push origin main',
    ])('does not widen a push grant to %j', async (command) => {
      expect(
        await evaluatePermissionRules(makeManager(), 'ask', {
          toolName,
          command,
        }),
      ).toMatchObject({ finalPermission: 'ask' });
    });

    it.each([
      'git push origin main > "$(other-command)"',
      'git push origin main 2> >(other-command)',
      'git push origin main <<< "$(other-command)"',
    ])(
      'checks unsupported syntax before a matching grant: %j',
      async (command) => {
        expect(matchesCommandPattern('git push *', command)).toBe(true);
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await evaluatePermissionRules(makeManager(), 'ask', {
            toolName,
            command,
          }),
        ).toEqual({ finalPermission: 'ask', pmForcedAsk: false });
      },
    );

    it.each([
      [pushRule, 'git > /tmp/protected push origin main', ['Bash(git *)']],
      [
        'Bash(git > /tmp/protected push *)',
        'git > /tmp/protected push origin main',
        [pushRule],
      ],
      [
        'Bash(git>/tmp/protected push *)',
        'git>/tmp/protected push origin main',
        [pushRule],
      ],
      [
        'Bash(git>/tmp/protected push *)',
        'git >/tmp/protected push origin main',
        [pushRule],
      ],
      ...[
        'git 1>/tmp/protected push origin main',
        'git 1> /tmp/protected push origin main',
        "git > '/tmp/protected' push origin main",
        'git &>/tmp/protected push origin main',
        'git >|/tmp/protected push origin main',
        'git >/tmp//protected push origin main',
        'git >/tmp/./protected push origin main',
        'git >"/tmp//./protected" push origin main',
        'git >/tmp/prot"ected" push origin main',
        "git push ''#x >/tmp/protected",
        'git push ""#x >/tmp/protected',
        "git push $''#x >/tmp/protected",
        'git >&/tmp/protected push origin main',
        'git 1>&/tmp/protected push origin main',
        'git 2>&1>/tmp/protected push origin main',
        'git 2>& 1>/tmp/protected push origin main',
        'git >&-push origin main >/tmp/protected',
        'git <&-push origin main >/tmp/protected',
      ].map(
        (command) =>
          [
            'Bash(git>/tmp/protected push *)',
            command,
            ['Bash(git *)'],
          ] as const,
      ),
      [
        'Bash(git>/tmp/protected push *)',
        'git>/tmp/protected push origin main',
        [],
      ],
      [
        "Bash(git>'/tmp/$literal' push *)",
        'git > /tmp/\\$literal push origin main',
        ['Bash(git *)'],
      ],
      [
        'Bash(git>/tmp/\\$literal push *)',
        "git > '/tmp/$literal' push origin main",
        ['Bash(git *)'],
      ],
      [
        "Bash(git>'/tmp/`literal`' push *)",
        'git > /tmp/\\`literal\\` push origin main',
        ['Bash(git *)'],
      ],
      [
        'Bash(git>/tmp/protected push *)',
        'FOO=$BAR git > /tmp/protected push origin main',
        ['Bash(git *)'],
      ],
      [
        'Bash(git>/tmp/protected push *)',
        'FOO="$BAR" git > /tmp/protected push origin main',
        ['Bash(git *)'],
      ],
      [
        'Bash(git>"*" push *)',
        'git>"$(other-command)" push origin main',
        [pushRule],
      ],
      [
        'Edit(//tmp/protected)',
        'git > /tmp/protected push origin main',
        [pushRule],
      ],
    ] as const)(
      'preserves restrictive rule %s for %s',
      async (rule, command, allow) => {
        const ctx = { toolName, command };
        const denied = makeManager([...allow], [], [rule]);
        expect(denied.hasRelevantRules(ctx)).toBe(true);
        expect(await evaluatePermissionRules(denied, 'ask', ctx)).toEqual({
          finalPermission: 'deny',
          pmForcedAsk: false,
        });
        expect(denied.findMatchingDenyRule(ctx)).toBe(rule);
        const asked = makeManager([...allow], [rule]);
        expect(asked.hasRelevantRules(ctx)).toBe(true);
        expect(await evaluatePermissionRules(asked, 'ask', ctx)).toEqual({
          finalPermission: 'ask',
          pmForcedAsk: true,
        });
        expect(asked.hasMatchingAskRule(ctx)).toBe(true);
      },
    );

    it.each([
      ['Bash(git>/tmp/protected push *)', './protected', '/tmp', undefined],
      ['Bash(git>/tmp/protected push *)', 'protected', '/elsewhere', '/tmp'],
      ['Bash(git>./protected push *)', '/tmp/protected', '/tmp', undefined],
      ['Bash(git>logs/* push *)', '/tmp/logs/protected', '/tmp', undefined],
      [
        'Bash(git>*/protected push *)',
        '/elsewhere/protected',
        '/tmp',
        undefined,
      ],
      ["Bash(git>'logs/*' push *)", "'/tmp/logs/*'", '/tmp', undefined],
    ] as const)(
      'preserves restrictive rule %s for target %s with cwd context',
      async (rule, target, configuredCwd, cwd) => {
        const ctx = {
          toolName,
          command: `git 2>${target} push origin main`,
          ...(cwd === undefined ? {} : { cwd }),
        };
        const denied = makeManager(['Bash(*)'], [], [rule], configuredCwd);
        expect(await evaluatePermissionRules(denied, 'ask', ctx)).toEqual({
          finalPermission: 'deny',
          pmForcedAsk: false,
        });
        expect(denied.findMatchingDenyRule(ctx)).toBe(rule);
        const asked = makeManager(['Bash(*)'], [rule], [], configuredCwd);
        expect(await evaluatePermissionRules(asked, 'ask', ctx)).toEqual({
          finalPermission: 'ask',
          pmForcedAsk: true,
        });
        expect(asked.hasMatchingAskRule(ctx)).toBe(true);
      },
    );

    it.each([
      'git >/tmp//protected push origin main',
      'git >./protected push origin main',
    ])(
      'does not widen an allow rule to an equivalent redirect spelling: %j',
      async (command) => {
        const rule = 'Bash(git >/tmp/protected push origin main)';
        const manager = makeManager([rule], [], [], '/tmp');
        expect(await manager.evaluate({ toolName, command })).toBe('ask');
        expect(
          await manager.evaluate({
            toolName,
            command: 'git >/tmp/protected push origin main',
          }),
        ).toBe('allow');
      },
    );

    it('does not turn a quoted redirect wildcard into a path pattern', async () => {
      const manager = makeManager(
        ['Bash(*)'],
        [],
        ["Bash(git>'logs/*' push *)"],
        '/tmp',
      );
      expect(
        await manager.evaluate({
          toolName,
          command: 'git 2>/tmp/logs/other push origin main',
        }),
      ).toBe('allow');
    });

    it.each([
      'git > /tmp/other push origin main',
      'git >&/tmp/other push origin main',
      "git push ''#x >/tmp/other",
      'git push origin main # >/tmp/protected',
      'FOO=$BAR git > /tmp/other push origin main',
      'git > /tmp/protected status',
      'git < /tmp/protected push origin main',
      'npm > /tmp/protected install',
    ])(
      'does not apply an unrelated redirect restriction to %j',
      async (command) => {
        const rule = 'Bash(git>/tmp/protected push *)';
        const ctx = { toolName, command };
        const denied = makeManager(['Bash(*)'], [], [rule]);
        expect(await evaluatePermissionRules(denied, 'ask', ctx)).toEqual({
          finalPermission: 'allow',
          pmForcedAsk: false,
        });
        expect(denied.findMatchingDenyRule(ctx)).toBeUndefined();
        const asked = makeManager(['Bash(*)'], [rule]);
        expect(await evaluatePermissionRules(asked, 'ask', ctx)).toEqual({
          finalPermission: 'allow',
          pmForcedAsk: false,
        });
        expect(asked.hasMatchingAskRule(ctx)).toBe(false);
      },
    );

    it.each([
      ['git > /tmp/\\$other push origin main', 'allow'],
      ['git > /tmp/\\$literal status', 'allow'],
      ['git > "/tmp/$literal" push origin main', 'ask'],
    ] as const)(
      'distinguishes literal redirect text from %j',
      async (command, expected) => {
        const rule = "Bash(git>'/tmp/$literal' push *)";
        const manager = makeManager(['Bash(git *)'], [], [rule]);
        const ctx = { toolName, command };
        expect(await manager.evaluate(ctx)).toBe(expected);
        expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
      },
    );

    it.each([
      { name: 'configured cwd', configuredCwd: '/elsewhere', cwd: undefined },
      {
        name: 'explicit context cwd',
        configuredCwd: '/project',
        cwd: '/elsewhere',
      },
    ])(
      'resolves relative redirects from $name and follows cd',
      async ({ configuredCwd, cwd }) => {
        const rule = 'Edit(/protected)';
        const manager = makeManager(
          ['Bash(cd *)', pushRule],
          [],
          [rule],
          configuredCwd,
        );
        const ctx = {
          toolName,
          command: 'git > protected push origin main',
          ...(cwd === undefined ? {} : { cwd }),
        };
        expect(await manager.evaluate(ctx)).toBe('ask');
        expect(await evaluatePermissionRules(manager, 'ask', ctx)).toEqual({
          finalPermission: 'ask',
          pmForcedAsk: false,
        });
        expect(manager.findMatchingDenyRule(ctx)).toBeUndefined();
        const changedDirectory = {
          ...ctx,
          command: `cd /project && ${ctx.command}`,
        };
        expect(await manager.evaluate(changedDirectory)).toBe('deny');
        expect(
          await evaluatePermissionRules(manager, 'ask', changedDirectory),
        ).toEqual({ finalPermission: 'deny', pmForcedAsk: false });
        expect(manager.findMatchingDenyRule(changedDirectory)).toBe(rule);
      },
    );

    it('does not enable raw wildcard allow rules across substitutions', async () => {
      expect(
        await evaluatePermissionRules(
          makeManager(['Bash(git>"*" push *)']),
          'ask',
          { toolName, command: 'git>"$(other-command)" push origin main' },
        ),
      ).toMatchObject({ finalPermission: 'ask' });
    });

    it.each([
      "env bash -c 'git push > $X'",
      "env FOO=1 bash -c 'git push > $X'",
      "env -u FOO bash -c 'git push > $X'",
      "env --unset FOO bash -c 'git push > $X'",
      "nice -n 5 bash -c 'git push > $X'",
      "nice --adjustment 5 bash -c 'git push > $X'",
      "! env bash -c 'git push > $X'",
      "sudo -u root bash -c 'git push > $X'",
      "timeout -s TERM 5 bash -c 'git push > $X'",
      "env sudo timeout 5 bash -c 'git push > $X'",
      "echo safe # it's a comment\nenv bash -c 'git push > $X'",
    ])(
      'vetoes an unresolved redirect inside a prefixed wrapper: %j',
      async (command) => {
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await makeManager(['Bash(*)']).evaluate({ toolName, command }),
        ).toBe('ask');
        const suggestions = await suggestCommandRules(
          command,
          toolName === 'monitor' ? 'Monitor' : 'Bash',
        );
        expect(suggestions.permissionRules).not.toContain(
          `${toolName === 'monitor' ? 'Monitor' : 'Bash'}(env *)`,
        );
        if (!command.startsWith('echo'))
          expect(suggestions.permissionRules).toEqual([]);
      },
    );

    it.each(['env', 'env -u FOO', 'nice -n 5', '! env'])(
      'retains static protected and unrelated paths inside a %s wrapper',
      async (prefix) => {
        const manager = makeManager(['Bash(*)'], [], ['Edit(//tmp/protected)']);
        expect(
          await manager.evaluate({
            toolName,
            command: `${prefix} bash -c 'git push > /tmp/protected'`,
          }),
        ).toBe('deny');
        expect(
          await manager.evaluate({
            toolName,
            command: `${prefix} bash -c 'git push > /tmp/other'`,
          }),
        ).toBe('allow');
      },
    );

    it.each(['env -S', 'env --unknown', 'stdbuf -oL', 'sudo -s'])(
      'keeps unknown prefix semantics on the ask path: %s',
      async (prefix) => {
        const command = `${prefix} bash -c 'git status'`;
        expect(
          await makeManager(['Bash(*)']).evaluate({ toolName, command }),
        ).toBe('ask');
        expect(
          (
            await suggestCommandRules(
              command,
              toolName === 'monitor' ? 'Monitor' : 'Bash',
            )
          ).permissionRules,
        ).toEqual([]);
      },
    );

    it('does not let the alternative backslash reading hide an executable suffix', async () => {
      expect(
        await makeManager(['Bash(echo *)']).evaluate({
          toolName,
          command: "echo 'a\\' b ' #literal' ; rm /tmp/protected",
        }),
      ).toBe('ask');
    });

    it('retains an executable suffix when a wrapper contains a comment', async () => {
      const manager = makeManager(['Bash(echo *)'], [], ['Bash(rm *)']);
      const ctx = {
        toolName,
        command: "bash -c 'echo hi # done' ; rm -rf /tmp/x",
      };
      expect(await manager.evaluate(ctx)).toBe('deny');
      expect(manager.findMatchingDenyRule(ctx)).toBe('Bash(rm *)');
    });

    it.each([
      '  git>/tmp/protected push origin main  ',
      '\tgit>/tmp/protected push origin main\t',
      '! git>/tmp/protected push origin main',
      'FOO=1 git>/tmp/protected push origin main',
      '! FOO=1 git>/tmp/protected push origin main',
      '  ! FOO="two words" BAR=2 git>/tmp/protected push origin main\t',
      '! FOO=1 git>/tmp/protected   push origin main',
      'FOO=1 git>/tmp/protected\tpush origin main',
    ])('keeps raw restrictions behind shell prefixes: %j', async (command) => {
      const rule = 'Bash(git>/tmp/protected push *)';
      const ctx = { toolName, command };
      for (const allow of [[], [pushRule]]) {
        const denied = makeManager(allow, [], [rule]);
        expect(denied.hasRelevantRules(ctx)).toBe(true);
        expect(await evaluatePermissionRules(denied, 'ask', ctx)).toEqual({
          finalPermission: 'deny',
          pmForcedAsk: false,
        });
        expect(denied.findMatchingDenyRule(ctx)).toBe(rule);
        const asked = makeManager(allow, [rule]);
        expect(asked.hasRelevantRules(ctx)).toBe(true);
        expect(await evaluatePermissionRules(asked, 'ask', ctx)).toEqual({
          finalPermission: 'ask',
          pmForcedAsk: true,
        });
        expect(asked.hasMatchingAskRule(ctx)).toBe(true);
      }
    });

    it('keeps interleaved assignments and redirects on the conservative path', async () => {
      expect(
        await evaluatePermissionRules(makeManager(), 'ask', {
          toolName,
          command: 'FOO=1 > /dev/null BAR=2 git push origin main',
        }),
      ).toMatchObject({ finalPermission: 'ask' });
    });

    it.each(['bash', 'cmd', 'powershell'] as const)(
      'keeps Bash-specific permission decisions scoped to %s',
      async (shell) => {
        shellType.value = shell;
        const command = 'git push origin $(echo main)';
        expect(matchesCommandPattern('git push *', command)).toBe(true);
        expect(hasUnsupportedShellSyntax(command)).toBe(true);
        expect(
          await evaluatePermissionRules(makeManager(), 'ask', {
            toolName,
            command,
          }),
        ).toEqual({
          finalPermission: shell === 'bash' ? 'ask' : 'allow',
          pmForcedAsk: false,
        });
        const denied = makeManager(['Bash(git *)'], [], [pushRule]);
        const redirected = {
          toolName,
          command: 'git > /tmp/protected push origin main',
        };
        expect(
          await evaluatePermissionRules(denied, 'ask', redirected),
        ).toEqual({
          finalPermission: shell === 'bash' ? 'deny' : 'allow',
          pmForcedAsk: false,
        });
        expect(denied.findMatchingDenyRule(redirected)).toBe(
          shell === 'bash' ? pushRule : undefined,
        );
      },
    );
  },
);

it('keeps full-command fallback equality literal', () => {
  const command = 'git <&- show "*"';
  expect(matchesCommandPattern(command, command)).toBe(true);
  expect(matchesCommandPattern(command, ' \t' + command + '\t ')).toBe(true);
  expect(matchesCommandPattern(command, 'git <&- show "other"')).toBe(false);
  for (const suffix of ['\r', '\v', '\f', '\u00a0']) {
    expect(matchesCommandPattern(command, command + suffix)).toBe(false);
  }
  const escaped = 'git <&- show "a\\\\b"';
  expect(matchesCommandPattern(escaped, ' \t' + escaped + '\t ')).toBe(true);
  expect(
    matchesCommandPattern('git <&- show path\\', 'git <&- show path\\ '),
  ).toBe(false);
});

it.each(['run_shell_command', 'monitor'])(
  'requires permission for the second command in a %s compound',
  async (toolName) => {
    const command = 'git push origin main; other-command';
    expect(matchesCommandPattern('git push *', command)).toBe(true);
    expect(
      await evaluatePermissionRules(makeManager(), 'ask', {
        toolName,
        command,
      }),
    ).toEqual({ finalPermission: 'ask', pmForcedAsk: false });
  },
);
