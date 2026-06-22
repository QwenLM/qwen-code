/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectSecondarySidebarSupport,
  registerChatViewProviders,
} from './chatViewRegistration.js';

const { registerWebviewViewProvider, executeCommand } = vi.hoisted(() => ({
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    registerWebviewViewProvider,
  },
  commands: {
    executeCommand,
  },
}));

describe('detectSecondarySidebarSupport', () => {
  it.each([
    { version: '1.106.0', supported: true },
    { version: '1.106.0-insider', supported: true },
    { version: '1.94.0', supported: false },
    { version: 'invalid', supported: false },
  ])('returns $supported for VS Code $version', ({ version, supported }) => {
    expect(detectSecondarySidebarSupport(version)).toBe(supported);
  });
});

describe('registerChatViewProviders', () => {
  const context = { subscriptions: [] as Array<{ dispose: () => void }> };

  beforeEach(() => {
    context.subscriptions = [];
    registerWebviewViewProvider.mockClear();
    executeCommand.mockClear();
  });

  it('registers sidebar and secondary hosts with retained webview context', () => {
    const createProvider = vi.fn();

    const supportsSecondarySidebar = registerChatViewProviders({
      context: context as never,
      createViewProvider: createProvider,
      vscodeVersion: '1.106.0',
    });

    expect(supportsSecondarySidebar).toBe(true);
    expect(registerWebviewViewProvider).toHaveBeenCalledTimes(2);
    const calls = registerWebviewViewProvider.mock.calls as unknown as Array<
      [
        string,
        unknown,
        { webviewOptions: { retainContextWhenHidden: boolean } },
      ]
    >;

    expect(calls.map((call) => call[0])).toEqual([
      'qwen-code.chatView.sidebar',
      'qwen-code.chatView.secondary',
    ]);
    expect(calls[0]?.[1]).not.toBe(calls[1]?.[1]);
    expect(calls[0]?.[2]).toEqual({
      webviewOptions: { retainContextWhenHidden: true },
    });
    expect(executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen-code:supportsSecondarySidebar',
      true,
    );
    expect(context.subscriptions).toHaveLength(2);
  });

  it('sets context key to false when secondary sidebar is unavailable', () => {
    registerChatViewProviders({
      context: context as never,
      createViewProvider: vi.fn(),
      vscodeVersion: '1.94.0',
    });

    expect(executeCommand).toHaveBeenCalledWith(
      'setContext',
      'qwen-code:supportsSecondarySidebar',
      false,
    );
  });
});
