/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPermissionRequestHookUpdates,
  buildPermissionCheckContext,
  persistPermissionOutcome,
} from './permission-helpers.js';
import type { PermissionManager } from '../permissions/permission-manager.js';

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

describe('applyPermissionRequestHookUpdates', () => {
  const setup = (sourceType?: string) => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const pm = {
      addSessionAllowRule: vi.fn(),
      addSessionDenyRule: vi.fn(),
      addSessionAskRule: vi.fn(),
      addPersistentRule: vi.fn(),
    };
    const apply = (updates: unknown[], signal = new AbortController().signal) =>
      applyPermissionRequestHookUpdates(
        updates,
        {
          getOnPersistPermissionRule: () => persist,
          getPermissionManager: () => pm as unknown as PermissionManager,
          getSessionSourceType: () => sourceType,
        },
        signal,
      );
    return { persist, pm, apply };
  };
  const addRules = (
    behavior: string,
    destination: string,
    rules: unknown[] = [{ toolName: 'Bash', ruleContent: 'npm test' }],
  ) => ({ type: 'addRules', rules, behavior, destination });

  it('adds session rules in memory only', async () => {
    const { persist, pm, apply } = setup();
    await apply([
      addRules('allow', 'session'),
      addRules('deny', 'session', [{ toolName: 'Bash', ruleContent: 'rm *' }]),
      addRules('ask', 'session', [{ toolName: 'WebFetch' }]),
    ]);
    expect(pm.addSessionAllowRule).toHaveBeenCalledWith('Bash(npm test)');
    expect(pm.addSessionDenyRule).toHaveBeenCalledWith('Bash(rm *)');
    expect(pm.addSessionAskRule).toHaveBeenCalledWith('WebFetch');
    expect(persist).not.toHaveBeenCalled();
    expect(pm.addPersistentRule).not.toHaveBeenCalled();
  });

  it.each([
    ['projectSettings', 'project'],
    ['localSettings', 'project'],
    ['userSettings', 'user'],
  ])('persists %s rules to the %s scope', async (destination, scope) => {
    const { persist, pm, apply } = setup();
    await apply([addRules('deny', destination)]);
    expect(persist).toHaveBeenCalledWith(scope, 'deny', 'Bash(npm test)');
    expect(pm.addPersistentRule).toHaveBeenCalledWith('Bash(npm test)', 'deny');
  });

  it('skips unsupported entries and rules without a tool name', async () => {
    const { persist, pm, apply } = setup();
    await apply([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      addRules('allow', 'elsewhere'),
      addRules('maybe', 'session'),
      { type: 'addRules', behavior: 'allow', destination: 'session' },
      addRules('allow', 'session', [{ ruleContent: 'npm test' }, null]),
      null,
    ]);
    expect(pm.addSessionAllowRule).not.toHaveBeenCalled();
    expect(pm.addSessionAskRule).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('skips malformed rule content without granting access to a whole tool', async () => {
    const { persist, pm, apply } = setup();
    const malformedRules = [
      { toolName: 'WebFetch', ruleContent: false },
      { toolName: 'WebFetch', ruleContent: null },
      { toolName: 'WebFetch', ruleContent: ' ' },
      { toolName: 'WebFetch', ruleContent: '' },
    ];
    await apply([
      addRules('allow', 'session', malformedRules),
      addRules('allow', 'userSettings', malformedRules),
    ]);
    expect(pm.addSessionAllowRule).not.toHaveBeenCalled();
    expect(pm.addPersistentRule).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('allows only user and session rule destinations in standalone sessions', async () => {
    const { persist, pm, apply } = setup('standalone');
    await apply([
      addRules('allow', 'projectSettings'),
      addRules('deny', 'localSettings'),
      addRules('ask', 'userSettings'),
      addRules('allow', 'session'),
    ]);
    expect(persist).toHaveBeenCalledExactlyOnceWith(
      'user',
      'ask',
      'Bash(npm test)',
    );
    expect(pm.addPersistentRule).toHaveBeenCalledExactlyOnceWith(
      'Bash(npm test)',
      'ask',
    );
    expect(pm.addSessionAllowRule).toHaveBeenCalledExactlyOnceWith(
      'Bash(npm test)',
    );
  });

  it('stops applying rules when the tool call is cancelled during a write', async () => {
    const { persist, pm, apply } = setup();
    const controller = new AbortController();
    persist.mockImplementationOnce(async () => controller.abort());
    await apply(
      [addRules('allow', 'projectSettings'), addRules('allow', 'session')],
      controller.signal,
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(pm.addPersistentRule).not.toHaveBeenCalled();
    expect(pm.addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('keeps going when a rule cannot be persisted', async () => {
    const { persist, pm, apply } = setup();
    persist.mockRejectedValueOnce(new Error('read-only settings'));
    await apply([
      addRules('allow', 'projectSettings', [
        { toolName: 'Bash', ruleContent: 'npm test' },
        { toolName: 'Bash', ruleContent: 'npm run lint' },
      ]),
    ]);
    expect(pm.addPersistentRule).toHaveBeenCalledOnce();
    expect(pm.addPersistentRule).toHaveBeenCalledWith(
      'Bash(npm run lint)',
      'allow',
    );
  });
});
