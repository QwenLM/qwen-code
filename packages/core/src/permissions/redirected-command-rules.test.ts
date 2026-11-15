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
import { extractCommandRules } from '../utils/shellAstParser.js';
import {
  matchesCommandPattern,
  matchesRule,
  parseRule,
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
) => {
  const manager = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => ask,
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
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
    ])('matches a push rule through a static redirect: %j', async (command) => {
      expect(
        await evaluatePermissionRules(makeManager(), 'ask', {
          toolName,
          command,
        }),
      ).toEqual({ finalPermission: 'allow', pmForcedAsk: false });
    });

    it.each([
      'git > /dev/null push origin main',
      'git 0<&3 push origin main',
      'git 0< /dev/null push origin main',
      '! git > /dev/null push origin main',
      'git status && git > /dev/null push origin main',
      'git status | git > /dev/null push origin main',
    ])('reuses persisted subcommand rules for %j', async (command) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-rule-'));
      onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
      const settingsPath = path.join(directory, 'settings.json');
      const settings = { permissions: { allow: [] as string[] } };
      const rules = (await extractCommandRules(command)).map(
        (rule) => `${toolName === 'monitor' ? 'Monitor' : 'Bash'}(${rule})`,
      );
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
        'git>/tmp/protected push origin main',
        [],
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
      [
        'Edit(/protected)',
        'cd /project && git > protected push origin main',
        ['Bash(cd *)', pushRule],
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

    it.each(['cmd', 'powershell'] as const)(
      'does not apply Bash redirection normalization to %s',
      async (shell) => {
        shellType.value = shell;
        expect(
          await evaluatePermissionRules(makeManager(), 'ask', {
            toolName,
            command: 'git > /dev/null push origin main',
          }),
        ).toMatchObject({ finalPermission: 'ask' });
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
  expect(
    matchesCommandPattern('git <&- show path\\', 'git <&- show path\\ '),
  ).toBe(false);
});

it('does not normalize unsplit command lists', () => {
  expect(
    matchesRule(
      parseRule(pushRule),
      'run_shell_command',
      'git > /dev/null push; other-command',
    ),
  ).toBe(false);
});
