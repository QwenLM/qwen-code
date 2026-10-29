/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { upgradeCommand } from './subscription-commands.js';

const mocks = vi.hoisted(() => ({ browser: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core/utils/secure-browser-launcher.js', () => ({
  openBrowserSecurely: mocks.browser,
}));
beforeEach(() => {
  mocks.browser.mockReset().mockResolvedValue(undefined);
});

it('opens the existing Qwen Code plans page from /upgrade', async () => {
  const context = createMockCommandContext();
  const result = await upgradeCommand.action!(context, '');
  expect(mocks.browser).toHaveBeenCalledWith(
    'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  );
  expect(result).toMatchObject({
    type: 'message',
    messageType: 'info',
    content: expect.stringContaining(
      'https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
    ),
  });
});

it('provides a usable plans URL when browser launch is suppressed or fails', async () => {
  const context = createMockCommandContext({
    services: { config: { isBrowserLaunchSuppressed: () => true } },
  });
  expect(await upgradeCommand.action!(context, '')).toMatchObject({
    messageType: 'info',
    content: expect.stringContaining('/?memberPlan=qwen_code'),
  });
  expect(mocks.browser).not.toHaveBeenCalled();
  mocks.browser.mockRejectedValue(new Error('private error'));
  expect(
    await upgradeCommand.action!(createMockCommandContext(), ''),
  ).toMatchObject({
    messageType: 'error',
    content:
      'Could not open your browser. Visit https://pre4-chat.qwen.ai/?memberPlan=qwen_code',
  });
});
