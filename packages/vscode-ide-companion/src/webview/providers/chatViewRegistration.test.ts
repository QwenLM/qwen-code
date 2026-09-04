/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerChatViewProviders } from './chatViewRegistration.js';

const { registerWebviewViewProvider } = vi.hoisted(() => ({
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => ({
  window: {
    registerWebviewViewProvider,
  },
}));

describe('registerChatViewProviders', () => {
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };

  beforeEach(() => {
    context.subscriptions = [];
    registerWebviewViewProvider.mockClear();
  });

  it('registers the sidebar host with retained webview context', () => {
    const createProvider = vi.fn();

    registerChatViewProviders({
      context: context as never,
      createViewProvider: createProvider,
    });

    expect(registerWebviewViewProvider).toHaveBeenCalledTimes(1);
    const calls = registerWebviewViewProvider.mock.calls as unknown as Array<
      [
        string,
        unknown,
        { webviewOptions: { retainContextWhenHidden: boolean } },
      ]
    >;

    expect(calls[0]?.[0]).toBe('qwen-code.chatView.sidebar');
    expect(calls[0]?.[2]).toEqual({
      webviewOptions: { retainContextWhenHidden: true },
    });
    expect(context.subscriptions).toHaveLength(1);
  });
});
