/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { PermissionQueue } from './PermissionQueue.js';
import type { QueuedPermissionPrompt } from './permissionQueueStore.js';
import type { SerializableConfirmationDetails } from '@qwen-code/core';
import { I18nTestProvider as UiI18nProvider } from '../../test-utils/I18nTestProvider.js';

const observed = vi.hoisted(() => ({ prompt: '' }));

vi.mock('../components/messages/ToolConfirmationMessage.js', () => ({
  ToolConfirmationMessage: ({
    confirmationDetails,
  }: {
    confirmationDetails: SerializableConfirmationDetails;
  }) => {
    observed.prompt =
      confirmationDetails.type === 'info' ? confirmationDetails.prompt : '';
    return null;
  },
}));

function queuedPrompt(
  confirmationDetails: SerializableConfirmationDetails,
): QueuedPermissionPrompt {
  return {
    toolUseId: 'classifier-unavailable',
    toolName: 'Bash',
    input: { command: 'echo test' },
    reason: {
      message: 'Confirmation required',
      denialKind: 'automode-unavailable',
      attribution: { type: 'other', reason: 'no rule' },
    },
    confirmationDetails,
    skippable: true,
    approve: vi.fn(),
    reject: vi.fn(),
    abort: vi.fn(),
  };
}

const execDetails: SerializableConfirmationDetails = {
  type: 'exec',
  title: 'echo test',
  command: 'echo test',
  rootCommand: 'echo',
  rootCommands: ['echo'],
};

// 保护不变量：同一请求只更新权限原因时，确认内容也必须更新；清空队列后不残留。
describe('PermissionQueue', () => {
  it.each([
    [
      'en',
      'Automatic safety checks are temporarily unavailable. This action needs your approval.',
    ],
    ['zh-CN', '自动安全检查暂时不可用，本次操作需要你确认。'],
  ] as const)(
    'shows the classifier fallback notice in %s',
    async (locale, notice) => {
      const item = queuedPrompt(execDetails);
      const view = await renderWithProviders(
        <UiI18nProvider forcedLocale={locale}>
          <PermissionQueue items={[item]} />
        </UiI18nProvider>,
      );
      try {
        await view.waitUntilReady();
        expect(view.lastFrame()).toContain(notice);
        expect(view.lastFrame()).toContain('Command: echo test');
        await expect(view).toMatchSvgSnapshot();
        expect(item.approve).not.toHaveBeenCalled();
        expect(item.reject).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    },
  );

  it.each([
    {
      type: 'mcp',
      title: 'MCP approval',
      serverName: 'test',
      toolName: 'fetch',
      toolDisplayName: 'Fetch',
    },
    {
      type: 'edit',
      title: 'Edit approval',
      fileName: 'test.ts',
      filePath: '/repo/test.ts',
      fileDiff: '',
      originalContent: null,
      newContent: '',
    },
  ] satisfies SerializableConfirmationDetails[])(
    'shows the notice independently of the $type details',
    async (details) => {
      const view = await renderWithProviders(
        <UiI18nProvider forcedLocale="en">
          <PermissionQueue items={[queuedPrompt(details)]} />
        </UiI18nProvider>,
      );
      try {
        expect(view.lastFrame()).toContain(
          'Automatic safety checks are temporarily unavailable.',
        );
      } finally {
        view.unmount();
      }
    },
  );

  it('shows and removes the notice when the same prompt reason changes', async () => {
    const unavailable = queuedPrompt(execDetails);
    const ordinary = {
      ...unavailable,
      reason: {
        message: 'Confirmation required',
        attribution: { type: 'other' as const, reason: 'no rule' },
      },
    };
    const renderQueue = (item: QueuedPermissionPrompt) => (
      <UiI18nProvider forcedLocale="en">
        <PermissionQueue items={[item]} />
      </UiI18nProvider>
    );
    const view = await renderWithProviders(renderQueue(ordinary));
    try {
      expect(view.lastFrame()).not.toContain('Automatic safety checks');
      view.rerender(renderQueue(unavailable));
      await waitFor(() =>
        expect(view.lastFrame()).toContain('Automatic safety checks'),
      );
      view.rerender(renderQueue(ordinary));
      await waitFor(() =>
        expect(view.lastFrame()).not.toContain('Automatic safety checks'),
      );
      view.rerender(<PermissionQueue items={[]} />);
      await waitFor(() =>
        expect(view.lastFrame({ allowEmpty: true }).trim()).toBe(''),
      );
    } finally {
      view.unmount();
    }
  });

  it('refreshes confirmation details when only the permission reason changes', async () => {
    const item: QueuedPermissionPrompt = {
      toolUseId: 'reason-refresh',
      toolName: 'Bash',
      input: { command: 'echo test' },
      reason: {
        message: 'Confirmation required',
        decisionPoint: 'mode.auto_denial_limit.keep_ask',
        attribution: { type: 'other', reason: 'Initial denial reason' },
      },
      skippable: false,
      approve: vi.fn(),
      reject: vi.fn(),
      abort: vi.fn(),
    };
    const view = await renderWithProviders(<PermissionQueue items={[item]} />);
    try {
      await waitFor(() =>
        expect(observed.prompt).toBe('Initial denial reason'),
      );
      view.rerender(
        <PermissionQueue
          items={[
            {
              ...item,
              reason: {
                ...item.reason,
                attribution: { type: 'other', reason: 'Updated denial reason' },
              },
            },
          ]}
        />,
      );
      await waitFor(() => {
        expect(observed.prompt).toBe('Updated denial reason');
      });
      view.rerender(<PermissionQueue items={[]} />);
      await waitFor(() =>
        expect(view.lastFrame({ allowEmpty: true }).trim()).toBe(''),
      );
    } finally {
      view.unmount();
    }
  });
});
