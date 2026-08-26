/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import { matchesCommandPattern } from './rule-parser.js';

function makeConfig(allow: string[]): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => [],
    getPermissionsDeny: () => [],
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

  it('does not let static env prefixes inherit exact, prefix, or glob rules', () => {
    expect(
      matchesCommandPattern('npm --version', 'FOO=bar npm --version'),
    ).toBe(false);
    expect(matchesCommandPattern('npm', 'FOO=bar npm --version')).toBe(false);
    expect(
      matchesCommandPattern(
        'python3 *',
        'PYTHONPATH=/tmp/lib python3 -c "print(1)"',
      ),
    ).toBe(false);
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

  it('also covers substitution-bearing env assignments from #10192', () => {
    expect(
      matchesCommandPattern(
        'npm --version',
        'X=$(printf hidden) npm --version',
      ),
    ).toBe(false);
  });

  it('allows an env-prefixed command when the rule explicitly includes it', () => {
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

  it('keeps the intentional Bash(*) allow-all behavior', () => {
    expect(
      matchesCommandPattern(
        '*',
        'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
      ),
    ).toBe(true);
  });

  it('fails closed end-to-end when only the unprefixed Bash command is allowed', async () => {
    const pm = new PermissionManager(makeConfig(['Bash(npm --version)']));
    pm.initialize();
    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'NODE_OPTIONS=--require=/tmp/preload.cjs npm --version',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
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
