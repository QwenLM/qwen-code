/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  buildPermissionRequestContent,
  interactionMetaFields,
  permissionCancelMessageFromResponse,
  permissionCancelReasonFromResponse,
  requestPermissionWithAbort,
  resolvePermissionOutcome,
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

    it('offers switch-to-Default before Reject and hides persistent choices', () => {
      const options = toPermissionOptions({
        type: 'exec',
        title: 'Confirm Shell Command',
        command: 'touch /tmp/marker',
        rootCommand: 'touch',
        autoModeFallback: {
          reason: 'classifier_unavailable',
          message: 'Classifier unavailable.',
        },
        onConfirm: async () => undefined,
      });

      expect(options).toEqual([
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedOnce,
          kind: 'allow_once',
        }),
        {
          optionId: ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
          name: 'Switch to Default Mode and allow once (recommended)',
          kind: 'allow_once',
        },
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.Cancel,
          kind: 'reject_once',
        }),
      ]);
    });

    it('can hide project persistence while keeping user persistence', () => {
      const options = toPermissionOptions(
        {
          type: 'exec',
          title: 'Confirm Shell Command',
          command: 'git status',
          rootCommand: 'git',
          permissionRules: ['Bash(git status)'],
          onConfirm: async () => undefined,
        },
        false,
        {
          allowProjectPersistence: false,
          allowUserPersistence: true,
        },
      );

      expect(options).not.toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
        }),
      );
      expect(options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlwaysUser,
        }),
      );
    });
  });

  describe('interactionMetaFields', () => {
    it('identifies ask_user_question requests and preserves their questions', () => {
      const questions = [
        {
          header: 'Continue?',
          question: 'Continue?',
          options: [{ label: 'Continue', description: 'Proceed.' }],
        },
      ];

      expect(
        interactionMetaFields({
          type: 'ask_user_question',
          title: 'Question',
          questions,
          onConfirm: async () => undefined,
        }),
      ).toEqual({
        qwenInteractionKind: 'user_question',
        qwenQuestions: questions,
      });
    });

    it('does not add interaction metadata for permission requests', () => {
      expect(
        interactionMetaFields({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          onConfirm: async () => undefined,
        }),
      ).toEqual({});
    });
  });

  it('places warnings before edit diff content', () => {
    const content = buildPermissionRequestContent({
      type: 'edit',
      title: 'Confirm edit',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileDiff: 'diff',
      originalContent: 'a',
      newContent: 'b',
      warnings: ['Unknown safety', 'Exact shell command: sed -i s/a/b/ a.txt'],
      onConfirm: async () => undefined,
    });

    expect(content.map((item) => item.type)).toEqual([
      'content',
      'content',
      'diff',
    ]);
    expect(content[0]).toMatchObject({
      content: { text: 'Unknown safety' },
    });
  });

  it('places classifier fallback guidance before other content', () => {
    const content = buildPermissionRequestContent({
      type: 'edit',
      title: 'Confirm edit',
      fileName: 'a.txt',
      filePath: '/tmp/a.txt',
      fileDiff: 'diff',
      originalContent: 'a',
      newContent: 'b',
      warnings: ['Existing warning'],
      autoModeFallback: {
        reason: 'classifier_unavailable',
        message: 'Classifier unavailable. Default Mode is recommended.',
      },
      onConfirm: async () => undefined,
    });

    expect(content.map((item) => item.type)).toEqual([
      'content',
      'content',
      'diff',
    ]);
    expect(content[0]).toMatchObject({
      content: {
        text: 'Classifier unavailable. Default Mode is recommended.',
      },
    });
  });

  it('accepts only an option that was actually offered', () => {
    const options = toPermissionOptions({
      type: 'exec',
      title: 'Confirm shell',
      command: 'python script.py',
      rootCommand: 'python',
      hideAlwaysAllow: true,
      onConfirm: async () => undefined,
    });
    expect(
      resolvePermissionOutcome(
        {
          outcome: {
            outcome: 'selected',
            optionId: ToolConfirmationOutcome.ProceedOnce,
          },
        },
        options,
      ),
    ).toBe(ToolConfirmationOutcome.ProceedOnce);
    expect(() =>
      resolvePermissionOutcome(
        {
          outcome: {
            outcome: 'selected',
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
          },
        },
        options,
      ),
    ).toThrow('unoffered option');
  });

  it('maps daemon cancel reason metadata and ignores empty reasons', () => {
    const cancelledResponse: RequestPermissionResponse = {
      outcome: { outcome: 'cancelled' },
      _meta: {
        'qwen.daemon.permissionCancelReason': 'agent_cancelled',
      },
    } as RequestPermissionResponse;
    const emptyReasonResponse: RequestPermissionResponse = {
      outcome: { outcome: 'cancelled' },
      _meta: {
        'qwen.daemon.permissionCancelReason': '',
      },
    } as RequestPermissionResponse;

    expect(permissionCancelReasonFromResponse(cancelledResponse)).toBe(
      'agent_cancelled',
    );
    expect(permissionCancelMessageFromResponse(cancelledResponse)).toBe(
      'Permission request was cancelled before the user answered.',
    );
    expect(permissionCancelReasonFromResponse(emptyReasonResponse)).toBe(
      undefined,
    );
    expect(permissionCancelMessageFromResponse(emptyReasonResponse)).toBe(
      undefined,
    );
  });

  it('aborts permission requests and ignores late settlement', async () => {
    let resolveRequest: ((value: never) => void) | undefined;
    const client = {
      requestPermission: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    };
    const controller = new AbortController();
    const request = requestPermissionWithAbort(
      client as never,
      { sessionId: 'session', options: [], toolCall: {} as never },
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toThrow('aborted');
    resolveRequest?.({} as never);
  });
});
