/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPermissionCheckContext } from './permission-helpers.js';

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
