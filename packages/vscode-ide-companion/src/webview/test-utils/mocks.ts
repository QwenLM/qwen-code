/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Test Mock Data Factory
 *
 * Provides factory functions for creating test data, ensuring consistency and maintainability.
 */

import { vi } from 'vitest';

/**
 * Create Mock Tool Call data
 *
 * Tool Call is the data structure when AI executes tool operations,
 * containing tool type, status, input/output, etc.
 *
 * @param overrides Properties to override default values
 */
export const createMockToolCall = (
  overrides: Record<string, unknown> = {},
) => ({
  toolCallId: 'test-tool-call-id',
  kind: 'execute' as const,
  title: 'Test Tool Call',
  status: 'pending' as const,
  timestamp: Date.now(),
  rawInput: {},
  ...overrides,
});

/**
 * Create Mock Message data
 *
 * Messages are the basic units in the chat interface,
 * including user messages, AI responses, thinking process, etc.
 *
 * @param overrides Properties to override default values
 */
export const createMockMessage = (overrides: Record<string, unknown> = {}) => ({
  role: 'user' as const,
  content: 'Test message',
  timestamp: Date.now(),
  ...overrides,
});

/**
 * Create Mock Session data
 *
 * Session contains a group of related messages, supporting history and session switching.
 *
 * @param overrides Properties to override default values
 */
export const createMockSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'test-session-id',
  title: 'Test Session',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messageCount: 0,
  ...overrides,
});

/**
 * Create Mock Permission Request data
 *
 * Permission requests are triggered when AI needs to perform sensitive operations,
 * requiring user to choose allow or reject.
 *
 * @param overrides Properties to override default values
 */
export const createMockPermissionRequest = (
  overrides: Record<string, unknown> = {},
) => ({
  toolCall: {
    toolCallId: 'test-tool-call-id',
    title: 'Read file',
    kind: 'read',
  },
  options: [
    { optionId: 'allow_once', label: 'Allow once', kind: 'allow' },
    { optionId: 'allow_always', label: 'Allow always', kind: 'allow' },
    { optionId: 'cancel', label: 'Cancel', kind: 'reject' },
  ],
  ...overrides,
});

/**
 * Create Mock WebView Panel
 *
 * WebView Panel is the container for displaying custom UI in VSCode.
 *
 * @param overrides Properties to override default values
 */
export const createMockWebviewPanel = (
  overrides: Record<string, unknown> = {},
) => ({
  webview: {
    html: '',
    options: {},
    asWebviewUri: vi.fn((uri) => ({
      toString: () => `vscode-webview://resource${uri.fsPath}`,
    })),
    cspSource: 'vscode-webview:',
    onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    postMessage: vi.fn(),
  },
  viewType: 'qwenCode.chat',
  title: 'Qwen Code',
  iconPath: null,
  visible: true,
  active: true,
  viewColumn: 1,
  onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
  reveal: vi.fn(),
  dispose: vi.fn(),
  ...overrides,
});

/**
 * Create Mock Extension Context
 *
 * Extension Context provides runtime context information for the extension.
 *
 * @param overrides Properties to override default values
 */
export const createMockExtensionContext = (
  overrides: Record<string, unknown> = {},
) => ({
  subscriptions: [],
  extensionUri: { fsPath: '/path/to/extension' },
  extensionPath: '/path/to/extension',
  globalState: {
    get: vi.fn(),
    update: vi.fn(),
    keys: vi.fn(() => []),
  },
  workspaceState: {
    get: vi.fn(),
    update: vi.fn(),
    keys: vi.fn(() => []),
  },
  environmentVariableCollection: {
    replace: vi.fn(),
    clear: vi.fn(),
  },
  extension: {
    packageJSON: { version: '1.0.0' },
  },
  ...overrides,
});

/**
 * Create Mock Diff Info
 *
 * Diff Info contains code comparison information.
 *
 * @param overrides Properties to override default values
 */
export const createMockDiffInfo = (
  overrides: Record<string, unknown> = {},
) => ({
  filePath: '/test/file.ts',
  oldContent: 'const x = 1;',
  newContent: 'const x = 2;',
  ...overrides,
});
