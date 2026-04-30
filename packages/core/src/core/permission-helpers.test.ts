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
});
