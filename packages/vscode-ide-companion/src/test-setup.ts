/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * 全局测试 setup 文件
 * 提供 VSCode API 的全局 mock，确保测试环境正确初始化
 *
 * 注意: VSCode API 的 mock 现在通过 vitest.config.ts 中的 alias 配置实现，
 * 指向 src/__mocks__/vscode.ts
 */

import { vi, beforeEach, afterEach } from 'vitest';

/**
 * Mock WebView API (window.acquireVsCodeApi)
 *
 * WebView 中的 React 组件通过 acquireVsCodeApi() 与扩展通信
 * 这里提供 mock 实现用于组件测试
 */
export const mockVSCodeWebViewAPI = {
  postMessage: vi.fn(),
  getState: vi.fn(() => ({})),
  setState: vi.fn(),
};

beforeEach(() => {
  // 设置 WebView API mock
  (globalThis as unknown as { acquireVsCodeApi: () => typeof mockVSCodeWebViewAPI }).acquireVsCodeApi =
    () => mockVSCodeWebViewAPI;
});

afterEach(() => {
  // 清理所有 mock 调用记录
  vi.clearAllMocks();
});
