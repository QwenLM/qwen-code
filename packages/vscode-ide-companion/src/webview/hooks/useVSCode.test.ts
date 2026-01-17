/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * useVSCode Hook 测试
 *
 * 测试目标：确保 VSCode API 通信正常，防止 WebView 与扩展通信失败
 *
 * 关键测试场景：
 * 1. API 获取 - 确保能正确获取 VSCode API
 * 2. postMessage - 确保消息能发送到扩展
 * 3. getState/setState - 确保状态能正确持久化
 * 4. 单例模式 - 确保 API 实例只创建一次
 * 5. 降级处理 - 确保在非 VSCode 环境中有 fallback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// 声明全局类型
declare global {
  var acquireVsCodeApi: (() => {
    postMessage: (message: unknown) => void;
    getState: () => unknown;
    setState: (state: unknown) => void;
  }) | undefined;
}

describe('useVSCode', () => {
  let originalAcquireVsCodeApi: typeof globalThis.acquireVsCodeApi;

  beforeEach(() => {
    // 保存原始值
    originalAcquireVsCodeApi = globalThis.acquireVsCodeApi;
    // 重置模块以清除缓存的 API 实例
    vi.resetModules();
  });

  afterEach(() => {
    // 恢复原始值
    globalThis.acquireVsCodeApi = originalAcquireVsCodeApi;
    vi.restoreAllMocks();
  });

  describe('API Acquisition - VSCode API 获取', () => {
    /**
     * 测试：获取 VSCode API
     *
     * 验证在 VSCode 环境中能正确获取 API
     * 这是 WebView 与扩展通信的基础
     */
    it('should acquire VSCode API when available', async () => {
      const mockApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      };

      globalThis.acquireVsCodeApi = vi.fn(() => mockApi);

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      expect(result.current).toBeDefined();
      expect(result.current.postMessage).toBeDefined();
      expect(result.current.getState).toBeDefined();
      expect(result.current.setState).toBeDefined();
    });

    /**
     * 测试：开发环境 fallback
     *
     * 验证在非 VSCode 环境中提供 mock 实现
     * 允许在浏览器中开发和测试
     */
    it('should provide fallback when acquireVsCodeApi is not available', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      expect(result.current).toBeDefined();
      expect(typeof result.current.postMessage).toBe('function');
      expect(typeof result.current.getState).toBe('function');
      expect(typeof result.current.setState).toBe('function');
    });
  });

  describe('postMessage - 消息发送', () => {
    /**
     * 测试：发送消息到扩展
     *
     * 验证 postMessage 能正确调用 VSCode API
     * 这是 WebView 向扩展发送命令的方式
     */
    it('should call postMessage on VSCode API', async () => {
      const mockPostMessage = vi.fn();
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: mockPostMessage,
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      }));

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      const testMessage = { type: 'test', data: { foo: 'bar' } };
      result.current.postMessage(testMessage);

      expect(mockPostMessage).toHaveBeenCalledWith(testMessage);
    });

    /**
     * 测试：发送不同类型的消息
     *
     * 验证各种消息类型都能正确发送
     */
    it('should handle different message types', async () => {
      const mockPostMessage = vi.fn();
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: mockPostMessage,
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      }));

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      // 测试各种消息类型
      const messages = [
        { type: 'sendMessage', data: { content: 'Hello' } },
        { type: 'cancelStreaming', data: {} },
        { type: 'newSession', data: {} },
        { type: 'permissionResponse', data: { optionId: 'allow' } },
        { type: 'login', data: {} },
      ];

      messages.forEach((msg) => {
        result.current.postMessage(msg);
      });

      expect(mockPostMessage).toHaveBeenCalledTimes(messages.length);
    });
  });

  describe('getState/setState - 状态持久化', () => {
    /**
     * 测试：获取状态
     *
     * 验证能正确获取 WebView 持久化的状态
     */
    it('should get state from VSCode API', async () => {
      const mockState = { messages: [], sessionId: 'test-123' };
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: vi.fn(),
        getState: vi.fn(() => mockState),
        setState: vi.fn(),
      }));

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      const state = result.current.getState();
      expect(state).toEqual(mockState);
    });

    /**
     * 测试：设置状态
     *
     * 验证能正确设置 WebView 持久化状态
     * 状态在 WebView 隐藏后仍能保留
     */
    it('should set state on VSCode API', async () => {
      const mockSetState = vi.fn();
      globalThis.acquireVsCodeApi = vi.fn(() => ({
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: mockSetState,
      }));

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      const newState = { messages: [{ content: 'test' }] };
      result.current.setState(newState);

      expect(mockSetState).toHaveBeenCalledWith(newState);
    });
  });

  describe('Singleton Pattern - 单例模式', () => {
    /**
     * 测试：API 实例只创建一次
     *
     * 验证 acquireVsCodeApi 只被调用一次
     * VSCode 要求此函数只能调用一次
     */
    it('should only call acquireVsCodeApi once', async () => {
      const mockAcquire = vi.fn(() => ({
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      }));
      globalThis.acquireVsCodeApi = mockAcquire;

      const { useVSCode } = await import('./useVSCode.js');

      // 多次调用 hook
      renderHook(() => useVSCode());
      renderHook(() => useVSCode());
      renderHook(() => useVSCode());

      // acquireVsCodeApi 应该只被调用一次
      expect(mockAcquire).toHaveBeenCalledTimes(1);
    });

    /**
     * 测试：多个组件共享同一实例
     *
     * 验证不同组件获取的是同一个 API 实例
     */
    it('should return same instance across multiple hooks', async () => {
      const mockApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => ({})),
        setState: vi.fn(),
      };
      globalThis.acquireVsCodeApi = vi.fn(() => mockApi);

      const { useVSCode } = await import('./useVSCode.js');

      const { result: result1 } = renderHook(() => useVSCode());
      const { result: result2 } = renderHook(() => useVSCode());

      // 应该是同一个实例
      expect(result1.current).toBe(result2.current);
    });
  });

  describe('Fallback Behavior - 降级行为', () => {
    /**
     * 测试：Fallback postMessage 不会报错
     *
     * 验证在开发环境中 mock 的 postMessage 能正常工作
     */
    it('should not throw on fallback postMessage', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      expect(() => {
        result.current.postMessage({ type: 'test', data: {} });
      }).not.toThrow();
    });

    /**
     * 测试：Fallback getState 返回空对象
     *
     * 验证在开发环境中 getState 返回空对象
     */
    it('should return empty object on fallback getState', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      const state = result.current.getState();
      expect(state).toEqual({});
    });

    /**
     * 测试：Fallback setState 不会报错
     *
     * 验证在开发环境中 mock 的 setState 能正常工作
     */
    it('should not throw on fallback setState', async () => {
      globalThis.acquireVsCodeApi = undefined;

      const { useVSCode } = await import('./useVSCode.js');
      const { result } = renderHook(() => useVSCode());

      expect(() => {
        result.current.setState({ test: 'value' });
      }).not.toThrow();
    });
  });
});
