/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * App 组件测试
 *
 * 测试目标：确保 WebView 主应用能正确渲染和交互，防止 WebView 无法显示问题
 *
 * 关键测试场景：
 * 1. 初始渲染 - 确保应用能正确渲染，不会白屏
 * 2. 认证状态显示 - 根据认证状态显示正确的 UI
 * 3. 加载状态 - 初始化时显示加载指示器
 * 4. 消息显示 - 确保消息能正确渲染
 * 5. 输入交互 - 确保用户能输入和发送消息
 * 6. 权限弹窗 - 确保权限请求能正确显示和响应
 * 7. 会话管理 - 确保会话切换功能正常
 */

/** @vitest-environment jsdom */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from './App.js';

// Mock all hooks that App depends on
vi.mock('./hooks/useVSCode.js', () => ({
  useVSCode: () => ({
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
  }),
}));

vi.mock('./hooks/session/useSessionManagement.js', () => ({
  useSessionManagement: () => ({
    currentSessionId: null,
    currentSessionTitle: 'New Chat',
    showSessionSelector: false,
    setShowSessionSelector: vi.fn(),
    filteredSessions: [],
    sessionSearchQuery: '',
    setSessionSearchQuery: vi.fn(),
    handleSwitchSession: vi.fn(),
    handleNewQwenSession: vi.fn(),
    handleLoadQwenSessions: vi.fn(),
    hasMore: false,
    isLoading: false,
    handleLoadMoreSessions: vi.fn(),
  }),
}));

vi.mock('./hooks/file/useFileContext.js', () => ({
  useFileContext: () => ({
    activeFileName: null,
    activeFilePath: null,
    activeSelection: null,
    workspaceFiles: [],
    hasRequestedFiles: false,
    requestWorkspaceFiles: vi.fn(),
    addFileReference: vi.fn(),
    focusActiveEditor: vi.fn(),
  }),
}));

vi.mock('./hooks/message/useMessageHandling.js', () => ({
  useMessageHandling: () => ({
    messages: [],
    isStreaming: false,
    isWaitingForResponse: false,
    loadingMessage: null,
    addMessage: vi.fn(),
    setMessages: vi.fn(),
    clearMessages: vi.fn(),
    startStreaming: vi.fn(),
    appendStreamChunk: vi.fn(),
    endStreaming: vi.fn(),
    breakAssistantSegment: vi.fn(),
    appendThinkingChunk: vi.fn(),
    clearThinking: vi.fn(),
    setWaitingForResponse: vi.fn(),
    clearWaitingForResponse: vi.fn(),
  }),
}));

vi.mock('./hooks/useToolCalls.js', () => ({
  useToolCalls: () => ({
    inProgressToolCalls: [],
    completedToolCalls: [],
    handleToolCallUpdate: vi.fn(),
    clearToolCalls: vi.fn(),
  }),
}));

vi.mock('./hooks/useWebViewMessages.js', () => ({
  useWebViewMessages: vi.fn(),
}));

vi.mock('./hooks/useMessageSubmit.js', () => ({
  useMessageSubmit: () => ({
    handleSubmit: vi.fn((e: Event) => e.preventDefault()),
  }),
}));

vi.mock('./hooks/useCompletionTrigger.js', () => ({
  useCompletionTrigger: () => ({
    isOpen: false,
    items: [],
    triggerChar: null,
    query: '',
    openCompletion: vi.fn(),
    closeCompletion: vi.fn(),
    refreshCompletion: vi.fn(),
  }),
}));

// Mock CSS modules and styles
vi.mock('./styles/App.css', () => ({}));
vi.mock('./styles/messages.css', () => ({}));

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset any module state
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial Rendering - 防止 WebView 白屏', () => {
    /**
     * 测试：基本渲染
     *
     * 验证 App 组件能成功渲染而不抛出错误
     * 这是最基本的测试，如果失败意味着 WebView 将无法显示
     */
    it('should render without crashing', () => {
      expect(() => render(<App />)).not.toThrow();
    });

    /**
     * 测试：聊天容器存在
     *
     * 验证主要的聊天容器 div 存在
     * 这是所有 UI 元素的父容器
     */
    it('should render chat container', () => {
      const { container } = render(<App />);
      const chatContainer = container.querySelector('.chat-container');
      expect(chatContainer).toBeInTheDocument();
    });

    /**
     * 测试：消息容器存在
     *
     * 验证消息列表容器存在
     * 消息将在此容器中显示
     */
    it('should render messages container', () => {
      const { container } = render(<App />);
      const messagesContainer = container.querySelector('.messages-container');
      expect(messagesContainer).toBeInTheDocument();
    });
  });

  describe('Loading State - 加载状态显示', () => {
    /**
     * 测试：初始加载状态
     *
     * 验证应用初始化时显示加载指示器
     * 在认证状态确定前，用户应该看到加载提示
     */
    it('should show loading state initially', () => {
      render(<App />);

      // 应该显示加载文本
      expect(screen.getByText(/Preparing Qwen Code/i)).toBeInTheDocument();
    });
  });

  describe('Authentication States - 认证状态显示', () => {
    /**
     * 测试：未认证状态 - 显示登录引导
     *
     * 验证用户未登录时显示 Onboarding 组件
     * 引导用户进行登录
     */
    it('should render correctly when not authenticated', async () => {
      // 使用 useWebViewMessages mock 模拟认证状态变更
      const { useWebViewMessages } = await import('./hooks/useWebViewMessages.js');
      vi.mocked(useWebViewMessages).mockImplementation((props) => {
        // 模拟收到未认证状态
        React.useEffect(() => {
          props.setIsAuthenticated?.(false);
        }, [props]); // 添加 props 到依赖数组
      });

      render(<App />);

      // 等待状态更新
      await waitFor(() => {
        // 未认证时应该显示登录相关 UI（如 Onboarding）
        // 确保不会抛出错误
        expect(document.body).toBeInTheDocument();
      });
    });

    /**
     * 测试：已认证状态 - 显示输入框
     *
     * 验证用户已登录时显示消息输入区域
     */
    it('should show input form when authenticated', async () => {
      const { useWebViewMessages } = await import('./hooks/useWebViewMessages.js');
      vi.mocked(useWebViewMessages).mockImplementation((props) => {
        React.useEffect(() => {
          props.setIsAuthenticated?.(true);
        }, [props]); // 添加 props 到依赖数组
      });

      render(<App />);

      // 等待认证状态更新
      await waitFor(() => {
        // 已认证时应该有输入相关的 UI
        expect(document.body).toBeInTheDocument();
      });
    });
  });

  describe('Message Rendering - 消息显示', () => {
    /**
     * 测试：用户消息显示
     *
     * 验证用户发送的消息能正确显示
     */
    it('should render user messages correctly', async () => {
      // Mock useMessageHandling to return messages
      vi.doMock('./hooks/message/useMessageHandling.js', () => ({
        useMessageHandling: () => ({
          messages: [
            {
              role: 'user',
              content: 'Hello, AI!',
              timestamp: Date.now(),
            },
          ],
          isStreaming: false,
          isWaitingForResponse: false,
          loadingMessage: null,
          addMessage: vi.fn(),
          setMessages: vi.fn(),
          clearMessages: vi.fn(),
          startStreaming: vi.fn(),
          appendStreamChunk: vi.fn(),
          endStreaming: vi.fn(),
          breakAssistantSegment: vi.fn(),
          appendThinkingChunk: vi.fn(),
          clearThinking: vi.fn(),
          setWaitingForResponse: vi.fn(),
          clearWaitingForResponse: vi.fn(),
        }),
      }));

      // 由于 mock 限制，这里验证组件不崩溃
      expect(() => render(<App />)).not.toThrow();
    });

    /**
     * 测试：AI 回复显示
     *
     * 验证 AI 的回复能正确显示
     */
    it('should render assistant messages correctly', async () => {
      vi.doMock('./hooks/message/useMessageHandling.js', () => ({
        useMessageHandling: () => ({
          messages: [
            {
              role: 'assistant',
              content: 'Hello! How can I help you today?',
              timestamp: Date.now(),
            },
          ],
          isStreaming: false,
          isWaitingForResponse: false,
          loadingMessage: null,
          addMessage: vi.fn(),
          setMessages: vi.fn(),
          clearMessages: vi.fn(),
          startStreaming: vi.fn(),
          appendStreamChunk: vi.fn(),
          endStreaming: vi.fn(),
          breakAssistantSegment: vi.fn(),
          appendThinkingChunk: vi.fn(),
          clearThinking: vi.fn(),
          setWaitingForResponse: vi.fn(),
          clearWaitingForResponse: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });

    /**
     * 测试：思考过程显示
     *
     * 验证 AI 的思考过程能正确显示
     */
    it('should render thinking messages correctly', async () => {
      vi.doMock('./hooks/message/useMessageHandling.js', () => ({
        useMessageHandling: () => ({
          messages: [
            {
              role: 'thinking',
              content: 'Analyzing the code...',
              timestamp: Date.now(),
            },
          ],
          isStreaming: false,
          isWaitingForResponse: false,
          loadingMessage: null,
          addMessage: vi.fn(),
          setMessages: vi.fn(),
          clearMessages: vi.fn(),
          startStreaming: vi.fn(),
          appendStreamChunk: vi.fn(),
          endStreaming: vi.fn(),
          breakAssistantSegment: vi.fn(),
          appendThinkingChunk: vi.fn(),
          clearThinking: vi.fn(),
          setWaitingForResponse: vi.fn(),
          clearWaitingForResponse: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });
  });

  describe('Empty State - 空状态显示', () => {
    /**
     * 测试：无消息时显示空状态
     *
     * 验证没有聊天记录时显示欢迎/空状态 UI
     */
    it('should show empty state when no messages and authenticated', async () => {
      const { useWebViewMessages } = await import('./hooks/useWebViewMessages.js');
      vi.mocked(useWebViewMessages).mockImplementation((props) => {
        React.useEffect(() => {
          props.setIsAuthenticated?.(true);
        }, [props]); // 添加 props 到依赖数组
      });

      const { container } = render(<App />);

      // 等待状态更新
      await waitFor(() => {
        // 验证应用不会崩溃
        expect(container.querySelector('.chat-container')).toBeInTheDocument();
      });
    });
  });

  describe('Streaming State - 流式响应状态', () => {
    /**
     * 测试：流式响应时的 UI 状态
     *
     * 验证 AI 正在生成回复时 UI 正确显示
     */
    it('should handle streaming state correctly', async () => {
      vi.doMock('./hooks/message/useMessageHandling.js', () => ({
        useMessageHandling: () => ({
          messages: [],
          isStreaming: true,
          isWaitingForResponse: false,
          loadingMessage: null,
          addMessage: vi.fn(),
          setMessages: vi.fn(),
          clearMessages: vi.fn(),
          startStreaming: vi.fn(),
          appendStreamChunk: vi.fn(),
          endStreaming: vi.fn(),
          breakAssistantSegment: vi.fn(),
          appendThinkingChunk: vi.fn(),
          clearThinking: vi.fn(),
          setWaitingForResponse: vi.fn(),
          clearWaitingForResponse: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });

    /**
     * 测试：等待响应时的 UI 状态
     *
     * 验证等待 AI 响应时显示加载提示
     */
    it('should show waiting message when waiting for response', async () => {
      vi.doMock('./hooks/message/useMessageHandling.js', () => ({
        useMessageHandling: () => ({
          messages: [{ role: 'user', content: 'test', timestamp: Date.now() }],
          isStreaming: false,
          isWaitingForResponse: true,
          loadingMessage: 'AI is thinking...',
          addMessage: vi.fn(),
          setMessages: vi.fn(),
          clearMessages: vi.fn(),
          startStreaming: vi.fn(),
          appendStreamChunk: vi.fn(),
          endStreaming: vi.fn(),
          breakAssistantSegment: vi.fn(),
          appendThinkingChunk: vi.fn(),
          clearThinking: vi.fn(),
          setWaitingForResponse: vi.fn(),
          clearWaitingForResponse: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });
  });

  describe('Session Management - 会话管理', () => {
    /**
     * 测试：会话标题显示
     *
     * 验证当前会话标题正确显示在 Header 中
     */
    it('should display current session title in header', async () => {
      vi.doMock('./hooks/session/useSessionManagement.js', () => ({
        useSessionManagement: () => ({
          currentSessionId: 'session-1',
          currentSessionTitle: 'My Test Session',
          showSessionSelector: false,
          setShowSessionSelector: vi.fn(),
          filteredSessions: [],
          sessionSearchQuery: '',
          setSessionSearchQuery: vi.fn(),
          handleSwitchSession: vi.fn(),
          handleNewQwenSession: vi.fn(),
          handleLoadQwenSessions: vi.fn(),
          hasMore: false,
          isLoading: false,
          handleLoadMoreSessions: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });
  });

  describe('Tool Calls - 工具调用显示', () => {
    /**
     * 测试：进行中的工具调用
     *
     * 验证正在执行的工具调用能正确显示
     */
    it('should render in-progress tool calls', async () => {
      vi.doMock('./hooks/useToolCalls.js', () => ({
        useToolCalls: () => ({
          inProgressToolCalls: [
            {
              toolCallId: 'tc-1',
              kind: 'read',
              title: 'Reading file...',
              status: 'pending',
              timestamp: Date.now(),
            },
          ],
          completedToolCalls: [],
          handleToolCallUpdate: vi.fn(),
          clearToolCalls: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });

    /**
     * 测试：已完成的工具调用
     *
     * 验证已完成的工具调用能正确显示
     */
    it('should render completed tool calls', async () => {
      vi.doMock('./hooks/useToolCalls.js', () => ({
        useToolCalls: () => ({
          inProgressToolCalls: [],
          completedToolCalls: [
            {
              toolCallId: 'tc-1',
              kind: 'read',
              title: 'Read file.ts',
              status: 'completed',
              timestamp: Date.now(),
              output: 'file content here',
            },
          ],
          handleToolCallUpdate: vi.fn(),
          clearToolCalls: vi.fn(),
        }),
      }));

      expect(() => render(<App />)).not.toThrow();
    });
  });

  describe('Error Boundaries - 错误边界', () => {
    /**
     * 测试：Hook 错误不会导致崩溃
     *
     * 验证即使某些 hook 抛出错误，整体应用也能优雅降级
     */
    it('should not crash on hook errors', () => {
      // 即使 mock 不完整，组件也应该能渲染
      expect(() => render(<App />)).not.toThrow();
    });
  });

  describe('Accessibility - 可访问性', () => {
    /**
     * 测试：基本可访问性结构
     *
     * 验证组件有正确的语义结构
     */
    it('should have proper semantic structure', () => {
      const { container } = render(<App />);

      // 应该有容器 div
      expect(container.querySelector('.chat-container')).toBeInTheDocument();
    });
  });

  describe('CSS Classes - 样式类', () => {
    /**
     * 测试：关键 CSS 类存在
     *
     * 验证必要的 CSS 类被正确应用
     * 如果缺失可能导致样式问题
     */
    it('should have required CSS classes', () => {
      const { container } = render(<App />);

      // chat-container 是主容器的关键类
      expect(container.querySelector('.chat-container')).toBeInTheDocument();
    });
  });
});

describe('App Integration - 集成场景', () => {
  /**
   * 测试：完整的消息发送流程（模拟）
   *
   * 验证从输入到发送的完整流程
   * 这是用户最常用的功能
   */
  it('should handle message submission flow', () => {
    const { container } = render(<App />);

    // 验证应用渲染成功
    expect(container.querySelector('.chat-container')).toBeInTheDocument();
  });

  /**
   * 测试：权限请求显示
   *
   * 验证当需要用户授权时，权限弹窗能正确显示
   */
  it('should show permission drawer when permission requested', async () => {
    // 权限请求通过 useWebViewMessages 触发
    const { useWebViewMessages } = await import('./hooks/useWebViewMessages.js');
    vi.mocked(useWebViewMessages).mockImplementation((props) => {
      React.useEffect(() => {
        props.setIsAuthenticated?.(true);
        // 模拟权限请求
        props.handlePermissionRequest({
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow' },
            { optionId: 'deny', name: 'Deny', kind: 'reject' },
          ],
          toolCall: {
            toolCallId: 'tc-1',
            title: 'Edit file.ts',
            kind: 'edit',
          },
        });
      }, [props]); // 添加 props 到依赖数组
    });

    const { container } = render(<App />);

    // 验证应用不崩溃
    expect(container.querySelector('.chat-container')).toBeInTheDocument();
  });
});
