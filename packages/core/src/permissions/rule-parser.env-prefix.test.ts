/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { extractCommandRules } from '../utils/shellAstParser.js';
import {
  findDangerousAllowRules,
  isDangerousBashRule,
} from './dangerousRules.js';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import { matchesCommandPattern, parseRule } from './rule-parser.js';

function makeConfig(
  allow: string[] = [],
  ask: string[] = [],
  deny: string[] = [],
): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => ask,
    getPermissionsDeny: () => deny,
    getProjectRoot: () => '/repo',
    getCwd: () => '/repo',
    getApprovalMode: () => 'default',
  };
}

describe('matchesCommandPattern environment prefixes', () => {
  it('keeps plain commands matching', () => {
    expect(matchesCommandPattern('npm --version', 'npm --version')).toBe(true);
    expect(matchesCommandPattern('python3 *', 'python3 -c "print(1)"')).toBe(
      true,
    );
  });

  it('does not let static env prefixes inherit exact or prefix rules', () => {
    expect(
      matchesCommandPattern('npm --version', 'FOO=bar npm --version'),
    ).toBe(false);
    expect(matchesCommandPattern('npm', 'FOO=bar npm --version')).toBe(false);
  });

  it('does not let NODE_OPTIONS widen an npm allow rule', () => {
    expect(
      matchesCommandPattern(
        'npm --version',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(false);
  });

  it('does not let GIT_CONFIG_* widen a git allow rule', () => {
    expect(
      matchesCommandPattern(
        'git status --short',
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=/tmp/fsmonitor.sh git status --short',
      ),
    ).toBe(false);
  });

  it('also covers both substitution forms from #10192', () => {
    expect(
      matchesCommandPattern(
        'npm --version',
        'X=$(printf hidden) npm --version',
      ),
    ).toBe(false);
    expect(
      matchesCommandPattern('npm --version', 'X=`printf hidden` npm --version'),
    ).toBe(false);
  });

  it('allows an env-prefixed command only when the rule includes it', () => {
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(true);
    expect(
      matchesCommandPattern(
        'PYTHONPATH=/tmp/lib python3 *',
        'PYTHONPATH=/tmp/lib python3 -c "print(1)"',
      ),
    ).toBe(true);
  });

  it('preserves quoted env values while canonicalizing unquoted whitespace', () => {
    expect(matchesCommandPattern('FOO="a b" npm', 'FOO="a b" npm')).toBe(true);
    expect(matchesCommandPattern('FOO=bar rm *', 'FOO=bar\trm -rf /')).toBe(
      true,
    );
    expect(matchesCommandPattern('FOO=bar rm *', 'FOO=bar  rm -rf /')).toBe(
      true,
    );
    expect(matchesCommandPattern('FOO=bar\trm *', 'FOO=bar rm -rf /')).toBe(
      true,
    );
  });

  it('keeps glob-valued env assignments intact instead of normalizing them to glob', () => {
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=* npm *',
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
      ),
    ).toBe(true);
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
      ),
    ).toBe(true);
    expect(matchesCommandPattern('FOO=? npm', 'FOO=? npm')).toBe(true);
  });

  it('does not widen assignment-only rules into arbitrary commands', () => {
    expect(matchesCommandPattern('FOO=bar', 'FOO=bar')).toBe(true);
    expect(matchesCommandPattern('FOO=bar', 'FOO=bar curl evil.sh')).toBe(
      false,
    );
  });

  it('keeps the intentional Bash(*) allow-all behavior', () => {
    expect(
      matchesCommandPattern(
        '*',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(true);
  });
});

describe('restrictive rules retain legacy env-prefix coverage', () => {
  it('keeps deny and ask rules restrictive for env-prefixed commands', async () => {
    const denyPm = new PermissionManager(
      makeConfig(['Bash(*)'], [], ['Bash(rm -rf *)']),
    );
    denyPm.initialize();
    await expect(
      denyPm.evaluate({
        toolName: 'run_shell_command',
        command: 'FOO=1 rm -rf /',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
    expect(
      denyPm.findMatchingDenyRule({
        toolName: 'run_shell_command',
        command: 'FOO=1 rm -rf /',
        cwd: '/repo',
      }),
    ).toBe('Bash(rm -rf *)');

    const askPm = new PermissionManager(
      makeConfig(['Bash(*)'], ['Bash(git push *)']),
    );
    askPm.initialize();
    const askCtx = {
      toolName: 'run_shell_command',
      command: 'FOO=bar git push --force',
      cwd: '/repo',
    } as const;
    await expect(askPm.evaluate(askCtx)).resolves.toBe('ask');
    expect(askPm.hasMatchingAskRule(askCtx)).toBe(true);
  });

  it('hardens the production hasRelevantRules gate', async () => {
    const pm = new PermissionManager(makeConfig([], [], ['Bash(rm -rf *)']));
    pm.initialize();
    const result = await evaluatePermissionRules(pm, 'allow', {
      toolName: 'run_shell_command',
      command: 'FOO=1 rm -rf /',
      cwd: '/repo',
    });
    expect(result.finalPermission).toBe('deny');
  });

  it('does not let a virtual Read allow downgrade the env-prefix ask decision', async () => {
    const pm = new PermissionManager(
      makeConfig(['Bash(cat /repo/file)', 'Read']),
    );
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'NODE_OPTIONS=--require=/tmp/preload.cjs cat /repo/file',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });
});

describe('env-prefixed grant generation and AUTO classification', () => {
  it('round-trips an Always-Allow rule through the matcher', async () => {
    const rules = await extractCommandRules('FOO=bar npm install');
    expect(rules).toEqual(['FOO=bar npm install']);

    const pm = new PermissionManager(makeConfig([`Bash(${rules[0]})`]));
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'FOO=bar npm install',
        cwd: '/repo',
      }),
    ).resolves.toBe('allow');
  });

  it('classifies env-prefixed interpreter allows as dangerous in AUTO mode', () => {
    const python = parseRule('Bash(X=1 python *)');
    const npx = parseRule('Bash(FOO=bar npx *)');
    expect(isDangerousBashRule(python)).toBe(true);
    expect(isDangerousBashRule(npx)).toBe(true);
    expect(findDangerousAllowRules([python, npx])).toEqual([python, npx]);
  });
});

describe('R3 env-prefix regressions', () => {
  it('does not widen wildcard assignment-only rules into commands', () => {
    expect(matchesCommandPattern('FOO=*', 'FOO=bar')).toBe(true);
    expect(matchesCommandPattern('FOO=*', 'FOO=bar curl evil.sh')).toBe(false);
  });

  it('keeps env-value wildcards inside the assignment shell word', () => {
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=* npm *',
        'NODE_OPTIONS=x sh -c evil npm',
      ),
    ).toBe(false);
    expect(
      matchesCommandPattern(
        'NODE_OPTIONS=* npm *',
        'NODE_OPTIONS=--require=*evil.cjs npm --version',
      ),
    ).toBe(true);
  });

  it('does not treat non-IFS whitespace as Bash word boundaries', () => {
    for (const whitespace of ['\u000b', '\u000c', '\r', '\u00a0']) {
      expect(
        matchesCommandPattern(
          'FOO=bar x *',
          `FOO=bar${whitespace}x curl evil.sh`,
        ),
      ).toBe(false);
    }
  });

  it('keeps legacy colon-star syntax out of env values', () => {
    expect(parseRule('Bash(git:*)').specifier).toBe('git *');
    expect(parseRule('Bash(FOO=a:* npm install)').specifier).toBe(
      'FOO=a:* npm install',
    );
  });

  it('keeps restrictive rules on env-prefixed compound segments', async () => {
    const denyPm = new PermissionManager(
      makeConfig(['Bash(*)'], [], ['Bash(rm -rf *)']),
    );
    denyPm.initialize();
    await expect(
      denyPm.evaluate({
        toolName: 'run_shell_command',
        command: 'echo hi && FOO=1 rm -rf /',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');

    const askPm = new PermissionManager(
      makeConfig(['Bash(*)'], ['Bash(git push *)']),
    );
    askPm.initialize();
    await expect(
      askPm.evaluate({
        toolName: 'run_shell_command',
        command: 'echo hi && FOO=bar git push --force',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });

  it('keeps restrictive matching aligned with Bash non-IFS whitespace', async () => {
    const pm = new PermissionManager(
      makeConfig(['Bash(*)'], [], ['Bash(curl *)']),
    );
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'FOO=bar\u000bx curl evil.sh',
        cwd: '/repo',
      }),
    ).resolves.toBe('deny');
  });

  it('round-trips multiple leading environment assignments', async () => {
    const command = 'A=1 B=2 npm install express';
    const rules = await extractCommandRules(command);
    expect(rules).toEqual(['A=1 B=2 npm install *']);
    const pm = new PermissionManager(makeConfig([`Bash(${rules[0]})`]));
    pm.initialize();
    await expect(
      pm.evaluate({ toolName: 'run_shell_command', command, cwd: '/repo' }),
    ).resolves.toBe('allow');
  });

  it('round-trips colon-star env values through generated rules', async () => {
    const command = 'FOO=a:* npm install';
    const rules = await extractCommandRules(command);
    expect(rules).toEqual(['FOO=a:* npm install']);
    expect(parseRule(`Bash(${rules[0]})`).specifier).toBe(rules[0]);
    const pm = new PermissionManager(makeConfig([`Bash(${rules[0]})`]));
    pm.initialize();
    await expect(
      pm.evaluate({ toolName: 'run_shell_command', command, cwd: '/repo' }),
    ).resolves.toBe('allow');
  });
});
