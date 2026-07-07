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

    it('returns plan options with RestorePrevious including prePlanMode', () => {
      const options = toPermissionOptions({
        type: 'plan',
        title: 'Would you like to proceed?',
        plan: 'Test plan',
        prePlanMode: 'yolo',
        onConfirm: async () => undefined,
      });

      expect(options).toHaveLength(4);
      expect(options[0]).toMatchObject({
        optionId: ToolConfirmationOutcome.RestorePrevious,
        name: 'Yes, restore previous mode (yolo)',
        kind: 'allow_once',
      });
      expect(options[1]).toMatchObject({
        optionId: ToolConfirmationOutcome.ProceedAlways,
        name: 'Yes, and auto-accept edits',
      });
      expect(options[2]).toMatchObject({
        optionId: ToolConfirmationOutcome.ProceedOnce,
        name: 'Yes, and manually approve edits',
      });
      expect(options[3]).toMatchObject({
        optionId: ToolConfirmationOutcome.Cancel,
        name: 'No, keep planning (esc)',
      });
    });

    it('defaults prePlanMode to "default" when not provided in plan options', () => {
      const options = toPermissionOptions({
        type: 'plan',
        title: 'Would you like to proceed?',
        plan: 'Test plan',
        onConfirm: async () => undefined,
      });

      expect(options[0]).toMatchObject({
        optionId: ToolConfirmationOutcome.RestorePrevious,
        name: 'Yes, restore previous mode (default)',
      });
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
