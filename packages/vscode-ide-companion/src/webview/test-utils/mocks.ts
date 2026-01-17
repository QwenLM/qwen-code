/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * 测试用 Mock 数据工厂
 *
 * 提供创建测试数据的工厂函数，确保测试数据的一致性和可维护性
 */

import { vi } from 'vitest';

/**
 * 创建 Mock Tool Call 数据
 *
 * Tool Call 是 AI 执行工具操作时的数据结构，
 * 包含工具类型、状态、输入输出等信息
 *
 * @param overrides 覆盖默认值的属性
 */
export const createMockToolCall = (overrides: Record<string, unknown> = {}) => ({
  toolCallId: 'test-tool-call-id',
  kind: 'execute' as const,
  title: 'Test Tool Call',
  status: 'pending' as const,
  timestamp: Date.now(),
  rawInput: {},
  ...overrides,
});

/**
 * 创建 Mock 消息数据
 *
 * 消息是聊天界面中的基本单元，
 * 包含用户消息、AI 回复、思考过程等
 *
 * @param overrides 覆盖默认值的属性
 */
export const createMockMessage = (overrides: Record<string, unknown> = {}) => ({
  role: 'user' as const,
  content: 'Test message',
  timestamp: Date.now(),
  ...overrides,
});

/**
 * 创建 Mock 会话数据
 *
 * 会话包含一组相关的消息，支持历史记录和会话切换
 *
 * @param overrides 覆盖默认值的属性
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
 * 创建 Mock 权限请求数据
 *
 * 权限请求在 AI 需要执行敏感操作时触发，
 * 用户需要选择允许或拒绝
 *
 * @param overrides 覆盖默认值的属性
 */
export const createMockPermissionRequest = (overrides: Record<string, unknown> = {}) => ({
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
 * 创建 Mock WebView Panel
 *
 * WebView Panel 是 VSCode 中显示自定义 UI 的容器
 *
 * @param overrides 覆盖默认值的属性
 */
export const createMockWebviewPanel = (overrides: Record<string, unknown> = {}) => ({
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
 * 创建 Mock Extension Context
 *
 * Extension Context 提供扩展运行时的上下文信息
 *
 * @param overrides 覆盖默认值的属性
 */
export const createMockExtensionContext = (overrides: Record<string, unknown> = {}) => ({
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
 * 创建 Mock Diff Info
 *
 * Diff Info 包含代码对比的信息
 *
 * @param overrides 覆盖默认值的属性
 */
export const createMockDiffInfo = (overrides: Record<string, unknown> = {}) => ({
  filePath: '/test/file.ts',
  oldContent: 'const x = 1;',
  newContent: 'const x = 2;',
  ...overrides,
});
