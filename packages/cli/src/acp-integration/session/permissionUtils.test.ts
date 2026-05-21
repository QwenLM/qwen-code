/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import {
  buildPermissionRequestContent,
  toPermissionOptions,
} from './permissionUtils.js';

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

  // Regression coverage for #4386 review: shell commands flagged with a
  // command-substitution warning should propagate that warning into the
  // ACP content channel so IDE clients can surface it. Without this,
  // IDE users approving substitution commands would see no hint.
  describe('buildPermissionRequestContent', () => {
    it('emits ⚠ content entries for each exec warning', () => {
      const content = buildPermissionRequestContent({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'python3 -c "print($(echo hello))"',
        rootCommand: 'python3',
        warnings: [
          'Contains command substitution ($(...), backticks, <(...), or >(...)).',
        ],
        onConfirm: async () => undefined,
      });

      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({
        type: 'content',
        content: { type: 'text' },
      });
      const node = content[0] as {
        type: 'content';
        content: { type: 'text'; text: string };
      };
      expect(node.content.text).toMatch(/^⚠ .*command substitution/);
    });

    it('emits no content for exec confirmations without warnings', () => {
      const content = buildPermissionRequestContent({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'npm install',
        rootCommand: 'npm',
        onConfirm: async () => undefined,
      });

      expect(content).toEqual([]);
    });
  });
});
