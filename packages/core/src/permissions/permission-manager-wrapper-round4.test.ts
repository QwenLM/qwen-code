/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { MAX_SHELL_UNWRAP_DEPTH } from '../utils/shell-command-prefixes.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import { PermissionManager } from './permission-manager.js';

function manager(
  rules: { allow?: string[]; ask?: string[]; deny?: string[] } = {},
  sandbox = true,
) {
  const pm = new PermissionManager({
    getPermissionsAllow: () => rules.allow ?? [],
    getPermissionsAsk: () => rules.ask ?? [],
    getPermissionsDeny: () => rules.deny ?? [],
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => sandbox,
  });
  pm.initialize();
  return pm;
}

const commands = [
  "bash -lc 'git push origin main'",
  "bash --login -c 'git push origin main'",
  "bash -ic 'git push origin main'",
  "bash --rcfile /tmp/startup -c 'git push origin main'",
  "bash -lc 'echo ready; git push origin main'",
  'bash -lc "sh -c \'git push origin main\'"',
  'bash -lc \'git push origin main\' "$IGNORED_POSITIONAL_ARG"',
  "bash -lc $'git\\x20push\\x20origin\\x20main'",
  'bash -lc "git push $ARGS"',
  'bash -lc "echo ready; git push $ARGS"',
];

const gitPushRule = 'Bash(git push *)';

describe('restrictive rules inside preserved monitor wrappers', () => {
  it('keeps a dynamic payload opaque while accepting dynamic positional data', () => {
    const unknown = 'bash -lc "$SCRIPT" \'git push origin main\'';
    expect(stripShellWrapper(unknown, true)).toBe(unknown);
    expect(
      manager({ deny: [gitPushRule] }).findMatchingDenyRule({
        toolName: 'monitor',
        command: unknown,
      }),
    ).toBeUndefined();
    expect(
      stripShellWrapper(
        'bash -lc \'git push origin main\' "$POSITIONAL"',
        true,
      ),
    ).toBe('git push origin main');
  });
  it.each(commands)('retains the inner deny for %s', async (command) => {
    const pm = manager({ deny: [gitPushRule] });
    const ctx = { toolName: 'monitor', command };
    expect({
      relevant: pm.hasRelevantRules(ctx),
      matchingDeny: pm.findMatchingDenyRule(ctx),
      matchingAsk: pm.hasMatchingAskRule(ctx),
      decision: await pm.evaluate(ctx),
      caller: await evaluatePermissionRules(pm, 'allow', ctx),
    }).toEqual({
      relevant: true,
      matchingDeny: gitPushRule,
      matchingAsk: false,
      decision: 'deny',
      caller: { finalPermission: 'deny', pmForcedAsk: false },
    });
  });

  it.each(commands)('retains the inner ask for %s', async (command) => {
    const pm = manager({ ask: [gitPushRule] });
    const ctx = { toolName: 'monitor', command };
    expect({
      relevant: pm.hasRelevantRules(ctx),
      matchingDeny: pm.findMatchingDenyRule(ctx),
      matchingAsk: pm.hasMatchingAskRule(ctx),
      decision: await pm.evaluate(ctx),
      caller: await evaluatePermissionRules(pm, 'allow', ctx),
    }).toEqual({
      relevant: true,
      matchingDeny: undefined,
      matchingAsk: true,
      decision: 'ask',
      caller: { finalPermission: 'ask', pmForcedAsk: true },
    });
  });

  it.each([false, true])(
    'uses an inner grant only for relevance with sandbox %s',
    async (sandbox) => {
      const pm = manager({ allow: ['Bash(git status *)'] }, sandbox);
      const ctx = {
        toolName: 'monitor',
        command: "bash -lc 'git status'",
      };
      expect(pm.hasRelevantRules(ctx)).toBe(true);
      expect(await pm.evaluate(ctx)).toBe('ask');
      expect(
        (await evaluatePermissionRules(pm, 'allow', ctx)).finalPermission,
      ).toBe('ask');
    },
  );

  it('preserves an outer deny before any inner grant', async () => {
    const outer = 'Bash(bash *)';
    const pm = manager({ allow: ['Bash(git status *)'], deny: [outer] });
    const ctx = { toolName: 'monitor', command: "bash -lc 'git status'" };
    expect(pm.findMatchingDenyRule(ctx)).toBe(outer);
    expect(await pm.evaluate(ctx)).toBe('deny');
  });

  it.each(['allow', 'ask', 'deny'])(
    'leaves an unconfigured caller decision at %s',
    async (defaultPermission) => {
      expect(
        await evaluatePermissionRules(manager(), defaultPermission, {
          toolName: 'monitor',
          command: "bash -lc 'git status'",
        }),
      ).toEqual({ finalPermission: defaultPermission, pmForcedAsk: false });
    },
  );

  it.each([
    'echo "bash -lc \'git push origin main\'"',
    "bash -lc \"printf '%s' 'git push origin main'\"",
    "bash -lc 'echo ready' _ 'git push origin main'",
  ])('does not treat literal arguments as programs: %s', async (command) => {
    const pm = manager({ deny: [gitPushRule], ask: [gitPushRule] });
    const ctx = { toolName: 'monitor', command };
    expect(pm.hasRelevantRules(ctx)).toBe(false);
    expect(pm.findMatchingDenyRule(ctx)).toBeUndefined();
    expect(pm.hasMatchingAskRule(ctx)).toBe(false);
    expect(await evaluatePermissionRules(pm, 'allow', ctx)).toEqual({
      finalPermission: 'allow',
      pmForcedAsk: false,
    });
  });

  it('keeps the ordinary monitor wrapper grant', async () => {
    const pm = manager({ allow: ['Bash(git status *)'] });
    expect(
      await evaluatePermissionRules(pm, 'allow', {
        toolName: 'monitor',
        command: "bash -c 'git status'",
      }),
    ).toEqual({ finalPermission: 'allow', pmForcedAsk: false });
  });

  it('keeps an explicit ordinary outer shell grant', async () => {
    const pm = manager({ allow: ['Bash(bash -c *)'] });
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: "bash -c 'git status'",
      }),
    ).toBe('allow');
  });

  it('also applies restrictive matching to a raw shell wrapper', async () => {
    const pm = manager({ deny: [gitPushRule] });
    expect(
      await pm.evaluate({
        toolName: 'run_shell_command',
        command: "bash -lc 'git push origin main'",
      }),
    ).toBe('deny');
  });

  it('does not resolve an inner relative redirect against the initial cwd', () => {
    const pm = manager({
      deny: ['Bash(git > /project/protected push *)'],
    });
    expect(
      pm.findMatchingDenyRule({
        toolName: 'monitor',
        command: "bash -lc 'cd /elsewhere; git > protected push origin main'",
      }),
    ).toBeUndefined();
    expect(
      pm.findMatchingDenyRule({
        toolName: 'monitor',
        command: "bash -lc 'git > /project/protected push origin main'",
      }),
    ).toBe('Bash(git > /project/protected push *)');
  });

  it('bounds nested wrapper matching while keeping unknown syntax unapproved', async () => {
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    const pm = manager({ allow: ['Bash(*)'], deny: [gitPushRule] });
    let command = 'git push origin main';
    for (let depth = 0; depth < MAX_SHELL_UNWRAP_DEPTH; depth++) {
      command = `bash -lc ${quote(command)}`;
    }
    expect(await pm.evaluate({ toolName: 'monitor', command })).toBe('deny');
    command = `bash -lc ${quote(command)}`;
    expect(await pm.evaluate({ toolName: 'monitor', command })).toBe('ask');
  });
});
