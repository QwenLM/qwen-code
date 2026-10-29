/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { PermissionManager } from '../permissions/permission-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPermissionCheckContext,
  persistPermissionOutcome,
  selectPathsDeniedByPermissionRules,
} from './permission-helpers.js';

describe('selectPathsDeniedByPermissionRules', () => {
  it.each([[], ['Edit'], ['Read(./other.txt)']])(
    'skips evaluation when deny rules %j do not match the result',
    async (...rules: string[]) => {
      const pm = new PermissionManager({
        getPermissionsAllow: () => [],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => rules,
        getProjectRoot: () => process.cwd(),
        getCwd: () => process.cwd(),
      });
      pm.initialize();
      const evaluate = vi.spyOn(pm, 'evaluate');

      expect(
        await selectPathsDeniedByPermissionRules(
          pm,
          ToolNames.GREP,
          process.cwd(),
          [path.resolve('file.txt')],
        ),
      ).toEqual(new Set());
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it.each(['Read', 'Read(./*.txt)'])(
    'evaluates each result when %s applies',
    async (rule) => {
      const pm = new PermissionManager({
        getPermissionsAllow: () => [],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [rule],
        getProjectRoot: () => process.cwd(),
        getCwd: () => process.cwd(),
      });
      pm.initialize();
      const evaluate = vi.spyOn(pm, 'evaluate');
      const paths = [path.resolve('a.txt'), path.resolve('b.txt')];

      expect(
        await selectPathsDeniedByPermissionRules(
          pm,
          ToolNames.GREP,
          process.cwd(),
          paths,
        ),
      ).toEqual(new Set(paths));
      expect(evaluate).toHaveBeenCalledTimes(2);
    },
  );

  it('skips evaluation when only an allow rule matches the result', async () => {
    const pm = new PermissionManager({
      getPermissionsAllow: () => ['Read(./file.txt)'],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [],
      getProjectRoot: () => process.cwd(),
      getCwd: () => process.cwd(),
    });
    pm.initialize();
    const evaluate = vi.spyOn(pm, 'evaluate');

    expect(
      await selectPathsDeniedByPermissionRules(
        pm,
        ToolNames.GREP,
        process.cwd(),
        [path.resolve('file.txt')],
      ),
    ).toEqual(new Set());
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not inspect deny matchers when the manager has no deny rules', async () => {
    const pm = new PermissionManager({
      getPermissionsAllow: () => [],
      getPermissionsAsk: () => [],
      getPermissionsDeny: () => [],
      getProjectRoot: () => process.cwd(),
      getCwd: () => process.cwd(),
    });
    pm.initialize();
    const findMatchingDenyRule = vi.spyOn(pm, 'findMatchingDenyRule');

    await selectPathsDeniedByPermissionRules(
      pm,
      ToolNames.GREP,
      process.cwd(),
      [path.resolve('file.txt')],
    );

    expect(findMatchingDenyRule).not.toHaveBeenCalled();
  });
});

describe('buildPermissionCheckContext', () => {
  it('uses an absolute directory as the permission cwd', () => {
    expect(
      buildPermissionCheckContext(
        'run_shell_command',
        {
          command: 'cat ./secret.txt',
          directory: '/project/subdir',
        },
        '/project',
      ),
    ).toMatchObject({
      toolName: 'run_shell_command',
      command: 'cat ./secret.txt',
      cwd: '/project/subdir',
    });
  });

  it('resolves a relative directory against the target dir', () => {
    expect(
      buildPermissionCheckContext(
        'run_shell_command',
        {
          command: 'cat ./secret.txt',
          directory: 'subdir',
        },
        '/project',
      ),
    ).toMatchObject({
      toolName: 'run_shell_command',
      command: 'cat ./secret.txt',
      cwd: path.resolve('/project', 'subdir'),
    });
  });

  it('returns raw monitor command — normalization is PM responsibility', () => {
    expect(
      buildPermissionCheckContext(
        'monitor',
        {
          command: String.raw`FOO="bar baz" /bin/bash --noprofile -c 'tail -f ./app.log &'`,
          directory: '/project/subdir',
        },
        '/project',
      ),
    ).toMatchObject({
      toolName: 'monitor',
      command: String.raw`FOO="bar baz" /bin/bash --noprofile -c 'tail -f ./app.log &'`,
      cwd: '/project/subdir',
    });
  });

  it('returns raw monitor command with suffix — normalization is PM responsibility', () => {
    expect(
      buildPermissionCheckContext(
        'monitor',
        {
          command: `/bin/bash -c 'tail -f ./app.log' && rm -rf /tmp/owned`,
        },
        '/project',
      ),
    ).toMatchObject({
      toolName: 'monitor',
      command: `/bin/bash -c 'tail -f ./app.log' && rm -rf /tmp/owned`,
    });
  });

  it('uses notebook_path as the file path for notebook_edit', () => {
    expect(
      buildPermissionCheckContext(
        'notebook_edit',
        {
          notebook_path: '/project/analysis.ipynb',
        },
        '/project',
      ),
    ).toMatchObject({
      toolName: 'notebook_edit',
      filePath: '/project/analysis.ipynb',
    });
  });

  it('uses server_name as the literal specifier for read_mcp_resource', () => {
    // Lets a persisted `ReadMcpResource(<server>)` rule match per-server
    // instead of a blanket grant over every configured MCP server.
    expect(
      buildPermissionCheckContext(
        'read_mcp_resource',
        { server_name: 'asys-mcp', uri: 'asight://x.md' },
        '/project',
      ),
    ).toMatchObject({
      toolName: 'read_mcp_resource',
      specifier: 'asys-mcp',
    });
  });
});

describe('persistPermissionOutcome', () => {
  it('never treats edit always-allow as a persistent project rule', async () => {
    const persist = vi.fn();
    const addPersistentRule = vi.fn();

    await persistPermissionOutcome(
      ToolConfirmationOutcome.ProceedAlways,
      {
        type: 'edit',
        title: 'Confirm edit',
        fileName: 'example.ts',
        filePath: '/project/example.ts',
        fileDiff: '',
        originalContent: null,
        newContent: 'updated',
        onConfirm: async () => undefined,
      },
      persist,
      { addPersistentRule } as never,
      { permissionRules: ['Write(**)'] },
    );

    expect(persist).not.toHaveBeenCalled();
    expect(addPersistentRule).not.toHaveBeenCalled();
  });

  it('stops permission updates after cancellation while a rule is being persisted', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = vi.fn(() => barrier);
    const addPersistentRule = vi.fn();
    const controller = new AbortController();
    const saving = persistPermissionOutcome(
      ToolConfirmationOutcome.ProceedAlwaysProject,
      {
        type: 'exec',
        title: 'Confirm shell',
        command: 'echo one',
        rootCommand: 'echo',
        permissionRules: ['Bash(echo one)', 'Bash(echo two)'],
        onConfirm: async () => undefined,
      },
      persist,
      { addPersistentRule } as never,
      undefined,
      () => !controller.signal.aborted,
    );
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    controller.abort();
    release();
    await saving;
    expect(persist).toHaveBeenCalledOnce();
    expect(addPersistentRule).not.toHaveBeenCalled();
  });

  it('keeps legacy exec always-allow project persistence', async () => {
    const persist = vi.fn();

    await persistPermissionOutcome(
      ToolConfirmationOutcome.ProceedAlways,
      {
        type: 'exec',
        title: 'Confirm shell',
        command: 'git status',
        rootCommand: 'git',
        permissionRules: ['Bash(git status)'],
        onConfirm: async () => undefined,
      },
      persist,
      undefined,
    );

    expect(persist).toHaveBeenCalledWith(
      'project',
      'allow',
      'Bash(git status)',
    );
  });
});
