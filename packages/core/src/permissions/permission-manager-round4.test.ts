/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PermissionManager } from './permission-manager.js';

const shellType = vi.hoisted(() => ({
  value: 'powershell' as 'powershell' | 'cmd',
}));

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

let root: string;
let unsafeRepo: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qwen-compound-cwd-'));
  unsafeRepo = path.join(root, 'unsafe-repo');
  mkdirSync(unsafeRepo);
  for (const cwd of [root, unsafeRepo]) {
    execFileSync('git', ['init', '-q'], { cwd });
  }
  execFileSync('git', ['config', 'diff.external', 'example-external-diff'], {
    cwd: unsafeRepo,
  });
  execFileSync('git', ['config', 'core.fsmonitor', 'example-fsmonitor'], {
    cwd: unsafeRepo,
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function manager(
  cwd = root,
  allow = ['Bash(cd *)', 'Bash(pushd *)'],
): PermissionManager {
  const pm = new PermissionManager({
    getPermissionsAllow: () => allow,
    getPermissionsAsk: () => [],
    getPermissionsDeny: () => [],
    getProjectRoot: () => root,
    getCwd: () => cwd,
    getShellExecutionSandbox: () => false,
  });
  pm.initialize();
  return pm;
}

describe.each(['powershell', 'cmd'] as const)(
  '%s compound directory changes',
  (shell) => {
    const separator = shell === 'cmd' ? ' && ' : '; ';

    beforeEach(() => {
      shellType.value = shell;
    });

    it.each([
      ['cd', 'diff'],
      ['cd', 'status'],
      ['pushd', 'diff'],
      ['pushd', 'status'],
    ])(
      'asks before %s changes the repository used by default git %s approval',
      async (changeDirectory, gitCommand) => {
        expect(
          await manager().evaluate({
            toolName: 'run_shell_command',
            command: `${changeDirectory} unsafe-repo${separator}git ${gitCommand}`,
          }),
        ).toBe('ask');
      },
    );

    it.each(['diff', 'status'])(
      'keeps git %s allowed in the safe cwd and asks in the configured repository',
      async (gitCommand) => {
        const ctx = {
          toolName: 'run_shell_command',
          command: `git ${gitCommand}`,
        };
        expect(await manager().evaluate(ctx)).toBe('allow');
        expect(await manager(unsafeRepo).evaluate(ctx)).toBe('ask');
      },
    );

    it.each(['echo ready', 'echo cd'])(
      'keeps ordinary compound read-only commands allowed: %s',
      async (first) => {
        expect(
          await manager().evaluate({
            toolName: 'run_shell_command',
            command: `${first}${separator}git diff`,
          }),
        ).toBe('allow');
      },
    );

    it('does not apply a later cd to an earlier Git command', async () => {
      expect(
        await manager().evaluate({
          toolName: 'run_shell_command',
          command: `git diff${separator}cd unsafe-repo`,
        }),
      ).toBe('allow');
    });

    it('preserves explicit approvals for both commands', async () => {
      expect(
        await manager(root, ['Bash(cd *)', 'Bash(git diff)']).evaluate({
          toolName: 'run_shell_command',
          command: `cd unsafe-repo${separator}git diff`,
        }),
      ).toBe('allow');
    });
  },
);
