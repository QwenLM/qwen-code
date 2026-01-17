/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebView 组件测试渲染工具
 *
 * 提供带有必要 Provider 和 mock 的渲染函数，
 * 简化 WebView React 组件的测试
 */

import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Mock VSCode WebView API
 *
 * WebView 中的组件通过 acquireVsCodeApi() 获取此 API，
 * 用于与 VSCode 扩展进行双向通信
 */
export const mockVSCodeAPI = {
  /** 向扩展发送消息 */
  postMessage: vi.fn(),
  /** 获取 WebView 持久化状态 */
  getState: vi.fn(() => ({})),
  /** 设置 WebView 持久化状态 */
  setState: vi.fn(),
};

/**
 * 测试用 Provider 包装器
 *
 * 如果组件需要特定的 Context Provider，可以在这里添加
 */
const AllTheProviders: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return <>{children}</>;
};

/**
 * 带 Provider 的渲染函数
 *
 * 使用方式：
 * ```tsx
 * import { renderWithProviders, screen } from './test-utils/render';
 *
 * it('should render component', () => {
 *   renderWithProviders(<MyComponent />);
 *   expect(screen.getByText('Hello')).toBeInTheDocument();
 * });
 * ```
 */
export const renderWithProviders = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) => render(ui, { wrapper: AllTheProviders, ...options });

/**
 * 模拟从扩展接收消息
 *
 * WebView 通过 window.addEventListener('message', ...) 接收消息
 * 使用此函数模拟扩展发送的消息
 *
 * @param type 消息类型
 * @param data 消息数据
 *
 * 使用示例：
 * ```ts
 * simulateExtensionMessage('authState', { authenticated: true });
 * ```
 */
export const simulateExtensionMessage = (type: string, data: unknown) => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, data },
    }),
  );
};

/**
 * 等待异步状态更新
 *
 * 用于等待 React 状态更新完成后再进行断言
 */
export const waitForStateUpdate = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

// 导出 @testing-library/react 的所有工具以及其他辅助函数
export * from '@testing-library/react';
