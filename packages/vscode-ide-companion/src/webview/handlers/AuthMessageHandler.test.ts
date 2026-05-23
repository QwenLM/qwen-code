/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockShowInputBox, mockShowQuickPick } = vi.hoisted(() => ({
  mockShowInputBox: vi.fn(),
  mockShowQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: mockShowQuickPick,
    showInputBox: mockShowInputBox,
  },
}));

import { AuthMessageHandler } from './AuthMessageHandler.js';

describe('AuthMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends authCancelled when the provider picker is dismissed', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );

    await handler.handle({ type: 'auth' });

    expect(sendToWebView).toHaveBeenCalledWith({ type: 'authCancelled' });
  });

  it('sends authCancelled when the api key input is dismissed mid-flow', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({ value: 'china' });
    mockShowInputBox.mockResolvedValue(undefined);

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );

    await handler.handle({ type: 'auth' });

    expect(sendToWebView).toHaveBeenCalledWith({ type: 'authCancelled' });
  });
});
