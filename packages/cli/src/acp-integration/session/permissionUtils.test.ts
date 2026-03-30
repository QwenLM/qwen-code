/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { toPermissionOptions } from './permissionUtils.js';

describe('permissionUtils', () => {
  describe('toPermissionOptions', () => {
    it('uses permissionRules for exec always-allow labels when available', () => {
      const options = toPermissionOptions({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'git add package.json',
        rootCommand: 'git',
        permissionRules: ['Bash(git add *)'],
        onConfirm: async () => undefined,
      });

      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
          name: 'Always Allow in project: git add *',
        }),
      );
      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
          name: 'Always Allow for user: git add *',
        }),
      );
    });

    it('falls back to rootCommand when exec permissionRules are unavailable', () => {
      const options = toPermissionOptions({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'git add package.json',
        rootCommand: 'git',
        onConfirm: async () => undefined,
      });

      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
          name: 'Always Allow in project: git',
        }),
      );
    });
  });
});
