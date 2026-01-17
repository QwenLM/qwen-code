/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * MessageHandler 测试
 *
 * 测试目标：确保消息能正确在 Extension 和 WebView 之间路由，防止消息丢失
 *
 * 关键测试场景：
 * 1. 消息路由 - 确保不同类型的消息路由到正确的处理器
 * 2. 会话管理 - 确保会话 ID 能正确设置和获取
 * 3. 权限处理 - 确保权限响应能正确传递
 * 4. 流式内容 - 确保流式响应能正确追加
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from './MessageHandler.js';
import type { QwenAgentManager } from '../services/qwenAgentManager.js';
import type { ConversationStore } from '../services/conversationStore.js';

describe('MessageHandler', () => {
  let messageHandler: MessageHandler;
  let mockAgentManager: QwenAgentManager;
  let mockConversationStore: ConversationStore;
  let mockSendToWebView: (message: unknown) => void;

  beforeEach(() => {
    // Mock QwenAgentManager - AI 代理管理器
    mockAgentManager = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      createNewSession: vi.fn().mockResolvedValue({ id: 'new-session' }),
      loadSession: vi.fn().mockResolvedValue([]),
      switchToSession: vi.fn().mockResolvedValue(undefined),
      cancelCurrentPrompt: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue({ requiresAuth: false }),
      disconnect: vi.fn(),
      currentSessionId: null,
    } as unknown as QwenAgentManager;

    // Mock ConversationStore - 本地会话存储
    mockConversationStore = {
      createConversation: vi.fn().mockResolvedValue({ id: 'conv-1', messages: [] }),
      getConversation: vi.fn().mockResolvedValue({ id: 'conv-1', messages: [] }),
      updateConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      // 添加 addMessage 方法用于消息存储
      addMessage: vi.fn().mockResolvedValue(undefined),
      // 添加会话历史相关方法
      getSessionHistory: vi.fn().mockResolvedValue([]),
      saveSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConversationStore;

    // Mock sendToWebView - 发送消息到 WebView
    mockSendToWebView = vi.fn();

    messageHandler = new MessageHandler(
      mockAgentManager,
      mockConversationStore,
      null, // 初始会话 ID
      mockSendToWebView,
    );
  });

  describe('route', () => {
    /**
     * 测试：路由 sendMessage 消息
     *
     * 验证用户发送的消息能正确传递给 AI 代理
     * 如果此功能失败，用户消息将无法发送
     */
    it('should route sendMessage to agent manager', async () => {
      await messageHandler.route({
        type: 'sendMessage',
        data: { content: 'Hello, AI!' },
      });

      expect(mockAgentManager.sendMessage).toHaveBeenCalled();
    });

    /**
     * 测试：路由 cancelStreaming 消息
     *
     * 验证取消请求能正确传递给 AI 代理
     * 用户点击停止按钮时需要此功能
     */
    it('should route cancelStreaming to agent manager', async () => {
      await messageHandler.route({
        type: 'cancelStreaming',
        data: {},
      });

      expect(mockAgentManager.cancelCurrentPrompt).toHaveBeenCalled();
    });

    /**
     * 测试：路由 newSession 消息
     *
     * 验证新建会话请求能正确传递给 AI 代理
     */
    it('should route newSession to agent manager', async () => {
      await messageHandler.route({
        type: 'newSession',
        data: {},
      });

      expect(mockAgentManager.createNewSession).toHaveBeenCalled();
    });

    /**
     * 测试：路由 loadSessions 消息
     *
     * 验证加载会话列表请求能正确处理
     */
    it('should route loadSessions to agent manager', async () => {
      await messageHandler.route({
        type: 'loadSessions',
        data: {},
      });

      expect(mockAgentManager.loadSession).toHaveBeenCalled();
    });

    /**
     * 测试：路由 switchSession 消息
     *
     * 验证切换会话请求能正确传递给 AI 代理
     */
    it('should route switchSession to agent manager', async () => {
      await messageHandler.route({
        type: 'switchSession',
        data: { sessionId: 'session-123' },
      });

      expect(mockAgentManager.switchToSession).toHaveBeenCalled();
    });

    /**
     * 测试：处理未知消息类型
     *
     * 验证未知消息类型不会导致崩溃
     */
    it('should handle unknown message types gracefully', async () => {
      await expect(
        messageHandler.route({
          type: 'unknownType',
          data: {},
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('setCurrentConversationId / getCurrentConversationId', () => {
    /**
     * 测试：设置和获取会话 ID
     *
     * 验证会话 ID 能正确设置和检索
     * 这对于会话状态管理至关重要
     */
    it('should set and get conversation ID', () => {
      messageHandler.setCurrentConversationId('test-conversation-id');

      expect(messageHandler.getCurrentConversationId()).toBe('test-conversation-id');
    });

    /**
     * 测试：初始会话 ID 为 null
     *
     * 验证初始状态下会话 ID 为 null
     */
    it('should return null initially', () => {
      expect(messageHandler.getCurrentConversationId()).toBeNull();
    });

    /**
     * 测试：设置 null 会话 ID
     *
     * 验证能将会话 ID 重置为 null
     */
    it('should allow setting null', () => {
      messageHandler.setCurrentConversationId('test-id');
      messageHandler.setCurrentConversationId(null);

      expect(messageHandler.getCurrentConversationId()).toBeNull();
    });
  });

  describe('setPermissionHandler', () => {
    /**
     * 测试：设置权限处理器
     *
     * 验证权限处理器能正确设置
     * 权限请求需要此处理器来响应用户选择
     */
    it('should set permission handler', async () => {
      const handler = vi.fn();
      messageHandler.setPermissionHandler(handler);

      // 触发权限响应
      await messageHandler.route({
        type: 'permissionResponse',
        data: { optionId: 'allow_once' },
      });

      expect(handler).toHaveBeenCalledWith({
        type: 'permissionResponse',
        data: { optionId: 'allow_once' },
      });
    });

    /**
     * 测试：权限响应正确传递选项 ID
     *
     * 验证用户选择的权限选项能正确传递
     */
    it('should pass correct optionId to handler', async () => {
      const handler = vi.fn();
      messageHandler.setPermissionHandler(handler);

      await messageHandler.route({
        type: 'permissionResponse',
        data: { optionId: 'allow_always' },
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { optionId: 'allow_always' },
        }),
      );
    });
  });

  describe('setLoginHandler', () => {
    /**
     * 测试：设置登录处理器
     *
     * 验证登录处理器能正确设置
     * 用户执行 /login 命令时需要此处理器
     */
    it('should set login handler', async () => {
      const loginHandler = vi.fn().mockResolvedValue(undefined);
      messageHandler.setLoginHandler(loginHandler);

      await messageHandler.route({
        type: 'login',
        data: {},
      });

      expect(loginHandler).toHaveBeenCalled();
    });
  });

  describe('appendStreamContent', () => {
    /**
     * 测试：追加流式内容
     *
     * 验证流式响应内容能正确追加
     * AI 回复是流式返回的，需要逐块追加
     */
    it('should append stream content without error', () => {
      expect(() => {
        messageHandler.appendStreamContent('Hello');
        messageHandler.appendStreamContent(' World');
      }).not.toThrow();
    });
  });

  describe('error handling', () => {
    /**
     * 测试：处理 sendMessage 错误
     *
     * 验证发送消息失败时不会导致崩溃
     */
    it('should handle sendMessage errors gracefully', async () => {
      vi.mocked(mockAgentManager.sendMessage).mockRejectedValue(
        new Error('Network error'),
      );

      // 应该不抛出错误（错误应该被内部处理）
      await expect(
        messageHandler.route({
          type: 'sendMessage',
          data: { content: 'test' },
        }),
      ).resolves.not.toThrow();
    });

    /**
     * 测试：处理 loadSessions 错误
     *
     * 验证加载会话失败时不会导致崩溃
     */
    it('should handle loadSessions errors gracefully', async () => {
      vi.mocked(mockAgentManager.loadSession).mockRejectedValue(
        new Error('Load failed'),
      );

      await expect(
        messageHandler.route({
          type: 'loadSessions',
          data: {},
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('message types coverage', () => {
    /**
     * 测试：支持的消息类型
     *
     * 验证所有关键消息类型都能被处理
     */
    const messageTypes = [
      'sendMessage',
      'cancelStreaming',
      'newSession',
      'loadSessions',
      'switchSession',
      'permissionResponse',
      'login',
      'attachFile',
      'openFile',
      'setApprovalMode',
    ];

    messageTypes.forEach((type) => {
      it(`should handle "${type}" message type`, async () => {
        await expect(
          messageHandler.route({
            type,
            data: {},
          }),
        ).resolves.not.toThrow();
      });
    });
  });
});
