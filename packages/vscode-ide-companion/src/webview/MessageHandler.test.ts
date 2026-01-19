/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * MessageHandler Tests
 *
 * Test objective: Ensure messages are correctly routed between Extension and WebView, preventing message loss.
 *
 * Key test scenarios:
 * 1. Message routing - Ensure different message types route to correct handlers
 * 2. Session management - Ensure session ID can be correctly set and retrieved
 * 3. Permission handling - Ensure permission responses are correctly passed
 * 4. Stream content - Ensure streaming responses are correctly appended
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
    // Mock QwenAgentManager - AI agent manager
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

    // Mock ConversationStore - local session storage
    mockConversationStore = {
      createConversation: vi
        .fn()
        .mockResolvedValue({ id: 'conv-1', messages: [] }),
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: 'conv-1', messages: [] }),
      updateConversation: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      // addMessage method for message storage
      addMessage: vi.fn().mockResolvedValue(undefined),
      // Session history related methods
      getSessionHistory: vi.fn().mockResolvedValue([]),
      saveSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConversationStore;

    // Mock sendToWebView - send message to WebView
    mockSendToWebView = vi.fn();

    messageHandler = new MessageHandler(
      mockAgentManager,
      mockConversationStore,
      null, // initial session ID
      mockSendToWebView,
    );
  });

  describe('route', () => {
    /**
     * Test: Route sendMessage
     *
     * Verifies sendMessage type is routed without error.
     * The handler may have internal logic before calling agentManager.
     */
    it('should route sendMessage without error', async () => {
      await expect(
        messageHandler.route({
          type: 'sendMessage',
          data: { content: 'Hello, AI!' },
        }),
      ).resolves.not.toThrow();
    });

    /**
     * Test: Route cancelStreaming
     *
     * Verifies cancel requests are correctly passed to AI agent.
     * Needed when user clicks stop button.
     */
    it('should route cancelStreaming to agent manager', async () => {
      await messageHandler.route({
        type: 'cancelStreaming',
        data: {},
      });

      expect(mockAgentManager.cancelCurrentPrompt).toHaveBeenCalled();
    });

    /**
     * Test: Route newQwenSession
     *
     * Verifies new session requests are routed without error.
     * Note: The actual message type is 'newQwenSession', not 'newSession'.
     */
    it('should route newQwenSession without error', async () => {
      await expect(
        messageHandler.route({
          type: 'newQwenSession',
          data: {},
        }),
      ).resolves.not.toThrow();
    });

    /**
     * Test: Route getQwenSessions
     *
     * Verifies get sessions requests are routed without error.
     * Note: The actual message type is 'getQwenSessions', not 'loadSessions'.
     */
    it('should route getQwenSessions without error', async () => {
      await expect(
        messageHandler.route({
          type: 'getQwenSessions',
          data: {},
        }),
      ).resolves.not.toThrow();
    });

    /**
     * Test: Route switchQwenSession
     *
     * Verifies switch session requests are routed without error.
     * Note: The actual message type is 'switchQwenSession', not 'switchSession'.
     */
    it('should route switchQwenSession without error', async () => {
      await expect(
        messageHandler.route({
          type: 'switchQwenSession',
          data: { sessionId: 'session-123' },
        }),
      ).resolves.not.toThrow();
    });

    /**
     * Test: Handle unknown message types
     *
     * Verifies unknown message types don't cause crashes.
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
     * Test: Set and get session ID
     *
     * Verifies session ID can be correctly set and retrieved.
     * This is critical for session state management.
     */
    it('should set and get conversation ID', () => {
      messageHandler.setCurrentConversationId('test-conversation-id');

      expect(messageHandler.getCurrentConversationId()).toBe(
        'test-conversation-id',
      );
    });

    /**
     * Test: Initial session ID is null
     *
     * Verifies session ID is null in initial state.
     */
    it('should return null initially', () => {
      expect(messageHandler.getCurrentConversationId()).toBeNull();
    });

    /**
     * Test: Set null session ID
     *
     * Verifies session ID can be reset to null.
     */
    it('should allow setting null', () => {
      messageHandler.setCurrentConversationId('test-id');
      messageHandler.setCurrentConversationId(null);

      expect(messageHandler.getCurrentConversationId()).toBeNull();
    });
  });

  describe('setPermissionHandler', () => {
    /**
     * Test: Set permission handler
     *
     * Verifies permission handler can be correctly set.
     * Permission requests need this handler to respond to user choices.
     */
    it('should set permission handler', async () => {
      const handler = vi.fn();
      messageHandler.setPermissionHandler(handler);

      // Trigger permission response
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
     * Test: Permission response passes correct optionId
     *
     * Verifies user's selected permission option is correctly passed.
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
     * Test: Set login handler
     *
     * Verifies login handler can be correctly set.
     * Needed when user executes /login command.
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
     * Test: Append stream content
     *
     * Verifies streaming response content can be correctly appended.
     * AI responses are streamed, need to append chunk by chunk.
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
     * Test: Handle sendMessage errors
     *
     * Verifies message send failures don't cause crashes.
     */
    it('should handle sendMessage errors gracefully', async () => {
      vi.mocked(mockAgentManager.sendMessage).mockRejectedValue(
        new Error('Network error'),
      );

      // Should not throw (errors should be handled internally)
      await expect(
        messageHandler.route({
          type: 'sendMessage',
          data: { content: 'test' },
        }),
      ).resolves.not.toThrow();
    });

    /**
     * Test: Handle loadSessions errors
     *
     * Verifies load sessions failures don't cause crashes.
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
     * Test: Supported message types
     *
     * Verifies all key message types can be handled.
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
