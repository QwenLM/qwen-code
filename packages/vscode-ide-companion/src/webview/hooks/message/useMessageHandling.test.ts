/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * useMessageHandling Hook 测试
 *
 * 测试目标：确保消息处理逻辑正确，防止消息显示异常
 *
 * 关键测试场景：
 * 1. 消息添加 - 确保消息能正确添加到列表
 * 2. 流式响应 - 确保流式内容能逐块追加
 * 3. 思考过程 - 确保 AI 思考过程正确处理
 * 4. 状态管理 - 确保加载状态正确更新
 * 5. 消息清除 - 确保能正确清空消息列表
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageHandling, type TextMessage } from './useMessageHandling.js';

describe('useMessageHandling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial State - 初始状态', () => {
    /**
     * 测试：初始状态
     *
     * 验证 hook 初始化时状态正确
     * 确保不会有意外的初始消息或状态
     */
    it('should have correct initial state', () => {
      const { result } = renderHook(() => useMessageHandling());

      expect(result.current.messages).toEqual([]);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.isWaitingForResponse).toBe(false);
      expect(result.current.loadingMessage).toBe('');
    });
  });

  describe('addMessage - 消息添加', () => {
    /**
     * 测试：添加用户消息
     *
     * 验证用户消息能正确添加到消息列表
     */
    it('should add user message', () => {
      const { result } = renderHook(() => useMessageHandling());

      const message: TextMessage = {
        role: 'user',
        content: 'Hello, AI!',
        timestamp: Date.now(),
      };

      act(() => {
        result.current.addMessage(message);
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content).toBe('Hello, AI!');
    });

    /**
     * 测试：添加 AI 回复
     *
     * 验证 AI 回复能正确添加到消息列表
     */
    it('should add assistant message', () => {
      const { result } = renderHook(() => useMessageHandling());

      const message: TextMessage = {
        role: 'assistant',
        content: 'Hello! How can I help?',
        timestamp: Date.now(),
      };

      act(() => {
        result.current.addMessage(message);
      });

      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].role).toBe('assistant');
    });

    /**
     * 测试：添加带文件上下文的消息
     *
     * 验证消息能包含文件上下文信息
     */
    it('should add message with file context', () => {
      const { result } = renderHook(() => useMessageHandling());

      const message: TextMessage = {
        role: 'user',
        content: 'Fix this code',
        timestamp: Date.now(),
        fileContext: {
          fileName: 'test.ts',
          filePath: '/src/test.ts',
          startLine: 1,
          endLine: 10,
        },
      };

      act(() => {
        result.current.addMessage(message);
      });

      expect(result.current.messages[0].fileContext).toBeDefined();
      expect(result.current.messages[0].fileContext?.fileName).toBe('test.ts');
    });

    /**
     * 测试：消息顺序
     *
     * 验证多条消息按添加顺序排列
     */
    it('should maintain message order', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.addMessage({
          role: 'user',
          content: 'First',
          timestamp: Date.now(),
        });
        result.current.addMessage({
          role: 'assistant',
          content: 'Second',
          timestamp: Date.now(),
        });
        result.current.addMessage({
          role: 'user',
          content: 'Third',
          timestamp: Date.now(),
        });
      });

      expect(result.current.messages).toHaveLength(3);
      expect(result.current.messages[0].content).toBe('First');
      expect(result.current.messages[1].content).toBe('Second');
      expect(result.current.messages[2].content).toBe('Third');
    });
  });

  describe('Streaming - 流式响应', () => {
    /**
     * 测试：开始流式响应
     *
     * 验证 startStreaming 正确设置状态并创建占位消息
     */
    it('should start streaming and create placeholder', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
      });

      expect(result.current.isStreaming).toBe(true);
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].role).toBe('assistant');
      expect(result.current.messages[0].content).toBe('');
    });

    /**
     * 测试：追加流式内容
     *
     * 验证流式内容能逐块追加到占位消息
     */
    it('should append stream chunks to placeholder', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
      });

      act(() => {
        result.current.appendStreamChunk('Hello');
        result.current.appendStreamChunk(' World');
        result.current.appendStreamChunk('!');
      });

      expect(result.current.messages[0].content).toBe('Hello World!');
    });

    /**
     * 测试：使用提供的时间戳
     *
     * 验证 startStreaming 能使用扩展提供的时间戳保持顺序
     */
    it('should use provided timestamp for ordering', () => {
      const { result } = renderHook(() => useMessageHandling());
      const customTimestamp = 1000;

      act(() => {
        result.current.startStreaming(customTimestamp);
      });

      expect(result.current.messages[0].timestamp).toBe(customTimestamp);
    });

    /**
     * 测试：结束流式响应
     *
     * 验证 endStreaming 正确重置状态
     */
    it('should end streaming correctly', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendStreamChunk('Response content');
        result.current.endStreaming();
      });

      expect(result.current.isStreaming).toBe(false);
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe('Response content');
    });

    /**
     * 测试：忽略流式结束后的晚到内容
     *
     * 验证用户取消后晚到的 chunk 被忽略
     */
    it('should ignore chunks after streaming ends', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendStreamChunk('Hello');
        result.current.endStreaming();
      });

      act(() => {
        result.current.appendStreamChunk(' Late chunk');
      });

      expect(result.current.messages[0].content).toBe('Hello');
    });
  });

  describe('breakAssistantSegment - 分段流式响应', () => {
    /**
     * 测试：打断当前流式段
     *
     * 验证工具调用插入时能打断当前流式段
     */
    it('should break current segment and start new one on next chunk', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendStreamChunk('Part 1');
        result.current.breakAssistantSegment();
      });

      act(() => {
        result.current.appendStreamChunk('Part 2');
      });

      // 应该有两条 assistant 消息
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].content).toBe('Part 1');
      expect(result.current.messages[1].content).toBe('Part 2');
    });
  });

  describe('Thinking - 思考过程', () => {
    /**
     * 测试：追加思考内容
     *
     * 验证 AI 思考过程能正确追加
     */
    it('should append thinking chunks', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendThinkingChunk('Analyzing');
        result.current.appendThinkingChunk(' the code');
      });

      const thinkingMsg = result.current.messages.find(
        (m: TextMessage) => m.role === 'thinking',
      );
      expect(thinkingMsg).toBeDefined();
      expect(thinkingMsg?.content).toBe('Analyzing the code');
    });

    /**
     * 测试：流式结束时清除思考消息
     *
     * 验证流式结束后思考消息被移除
     */
    it('should remove thinking message on end streaming', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendThinkingChunk('Thinking...');
        result.current.appendStreamChunk('Response');
        result.current.endStreaming();
      });

      const thinkingMsg = result.current.messages.find(
        (m: TextMessage) => m.role === 'thinking',
      );
      expect(thinkingMsg).toBeUndefined();
    });

    /**
     * 测试：手动清除思考消息
     *
     * 验证 clearThinking 正确移除思考消息
     */
    it('should clear thinking message manually', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendThinkingChunk('Thinking...');
      });

      expect(
        result.current.messages.find((m: TextMessage) => m.role === 'thinking'),
      ).toBeDefined();

      act(() => {
        result.current.clearThinking();
      });

      expect(
        result.current.messages.find((m) => m.role === 'thinking'),
      ).toBeUndefined();
    });

    /**
     * 测试：忽略流式结束后的思考内容
     *
     * 验证用户取消后晚到的思考内容被忽略
     */
    it('should ignore thinking chunks after streaming ends', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.endStreaming();
      });

      act(() => {
        result.current.appendThinkingChunk('Late thinking');
      });

      expect(
        result.current.messages.find((m: TextMessage) => m.role === 'thinking'),
      ).toBeUndefined();
    });
  });

  describe('Loading State - 加载状态', () => {
    /**
     * 测试：设置等待响应状态
     *
     * 验证 setWaitingForResponse 正确设置状态和消息
     */
    it('should set waiting for response state', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.setWaitingForResponse('AI is thinking...');
      });

      expect(result.current.isWaitingForResponse).toBe(true);
      expect(result.current.loadingMessage).toBe('AI is thinking...');
    });

    /**
     * 测试：清除等待响应状态
     *
     * 验证 clearWaitingForResponse 正确重置状态
     */
    it('should clear waiting for response state', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.setWaitingForResponse('Loading...');
        result.current.clearWaitingForResponse();
      });

      expect(result.current.isWaitingForResponse).toBe(false);
      expect(result.current.loadingMessage).toBe('');
    });
  });

  describe('clearMessages - 消息清除', () => {
    /**
     * 测试：清除所有消息
     *
     * 验证 clearMessages 正确清空消息列表
     */
    it('should clear all messages', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.addMessage({
          role: 'user',
          content: 'Test 1',
          timestamp: Date.now(),
        });
        result.current.addMessage({
          role: 'assistant',
          content: 'Test 2',
          timestamp: Date.now(),
        });
      });

      expect(result.current.messages).toHaveLength(2);

      act(() => {
        result.current.clearMessages();
      });

      expect(result.current.messages).toHaveLength(0);
    });
  });

  describe('setMessages - 直接设置消息', () => {
    /**
     * 测试：直接设置消息列表
     *
     * 验证能直接替换整个消息列表（用于会话恢复）
     */
    it('should set messages directly', () => {
      const { result } = renderHook(() => useMessageHandling());

      const messages: TextMessage[] = [
        { role: 'user', content: 'Hello', timestamp: 1000 },
        { role: 'assistant', content: 'Hi there!', timestamp: 1001 },
      ];

      act(() => {
        result.current.setMessages(messages);
      });

      expect(result.current.messages).toEqual(messages);
    });
  });

  describe('Edge Cases - 边缘情况', () => {
    /**
     * 测试：空内容处理
     *
     * 验证空内容的处理不会导致问题
     */
    it('should handle empty content', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.addMessage({
          role: 'user',
          content: '',
          timestamp: Date.now(),
        });
      });

      expect(result.current.messages[0].content).toBe('');
    });

    /**
     * 测试：大量消息
     *
     * 验证能处理大量消息而不崩溃
     */
    it('should handle many messages', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        for (let i = 0; i < 100; i++) {
          result.current.addMessage({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${i}`,
            timestamp: Date.now() + i,
          });
        }
      });

      expect(result.current.messages).toHaveLength(100);
    });

    /**
     * 测试：快速连续操作
     *
     * 验证快速连续的操作不会导致状态异常
     */
    it('should handle rapid operations', () => {
      const { result } = renderHook(() => useMessageHandling());

      act(() => {
        result.current.startStreaming();
        result.current.appendStreamChunk('A');
        result.current.appendStreamChunk('B');
        result.current.appendStreamChunk('C');
        result.current.endStreaming();
        result.current.startStreaming();
        result.current.appendStreamChunk('D');
        result.current.endStreaming();
      });

      // 应该有两条 assistant 消息
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].content).toBe('ABC');
      expect(result.current.messages[1].content).toBe('D');
    });
  });
});
