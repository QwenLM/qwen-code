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
  QuickPickItemKind: {
    Separator: -1,
    Default: 0,
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
    // First pick: select provider (coding-plan)
    // Second pick: select base URL region
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({
        value: 'https://coding.dashscope.aliyuncs.com/v1',
      });
    // API key input: user cancels
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

  it('drives a fixed-baseUrl third-party provider through to authInteractiveHandler', async () => {
    // Provider pick → DeepSeek (fixed baseUrl, models step shown)
    mockShowQuickPick.mockResolvedValueOnce({ value: 'deepseek' });
    // API key input + comma-separated model IDs
    mockShowInputBox
      .mockResolvedValueOnce('sk-deepseek')
      .mockResolvedValueOnce('deepseek-v4-flash, deepseek-v4-pro');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    // No base URL picker should have been shown (DeepSeek baseUrl is a string)
    expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deepseek' }),
      expect.objectContaining({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      }),
    );
    expect(sendToWebView).not.toHaveBeenCalledWith({ type: 'authCancelled' });
  });

  it('sends authError and aborts when validateApiKey rejects the key', async () => {
    // coding-plan validateApiKey requires keys starting with sk-sp-
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({
        value: 'https://coding.dashscope.aliyuncs.com/v1',
      });
    mockShowInputBox.mockResolvedValueOnce('not-a-coding-plan-key');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'authError',
      data: { message: expect.stringContaining('Coding Plan') },
    });
    expect(authInteractiveHandler).not.toHaveBeenCalled();
  });

  it('shows a baseUrl picker for providers with BaseUrlOption arrays', async () => {
    // coding-plan has baseUrl: BaseUrlOption[] (China / Singapore)
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({
        value: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      });
    // User cancels at API key step to keep the test focused on the picker call
    mockShowInputBox.mockResolvedValueOnce(undefined);

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );

    await handler.handle({ type: 'auth' });

    // Second pick is the base URL selector; verify it was shown with the
    // BaseUrlOption entries (China + Singapore international).
    const baseUrlPickerCall = mockShowQuickPick.mock.calls[1];
    expect(baseUrlPickerCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'https://coding.dashscope.aliyuncs.com/v1',
        }),
        expect.objectContaining({
          description: 'https://coding-intl.dashscope.aliyuncs.com/v1',
        }),
      ]),
    );
  });
});
