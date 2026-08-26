/**
 * @license
 * Copyright 2026 Qwen
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

describe('leading env assignment substitution permissions (#10192)', () => {
  it('keeps static env-prefix compatibility', () => {
    expect(
      matchesCommandPattern('npm --version', 'FOO=bar npm --version'),
    ).toBe(true);
    expect(
      matchesCommandPattern('npm --version', "FOO='$(literal)' npm --version"),
    ).toBe(true);
  });

  it.each([
    'X=$(printf hidden) npm --version',
    'X=`printf hidden` npm --version',
    'X="$(printf hidden)" npm --version',
  ])('does not strip an env prefix containing substitution: %s', (command) => {
    expect(matchesCommandPattern('npm --version', command)).toBe(false);
  });

  it('does not let a saved Bash allow downgrade substitution to allow', async () => {
    const pm = new PermissionManager(makeConfig(['Bash(npm --version)']));
    pm.initialize();

    await expect(
      pm.evaluate({
        toolName: 'run_shell_command',
        command: 'X=$(printf hidden) npm --version',
        cwd: '/repo',
      }),
    ).resolves.toBe('ask');
  });
});
