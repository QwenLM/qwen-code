/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * useMessageHandling Hook Tests
 *
 * Test objective: Ensure message handling logic is correct, preventing message display issues.
 *
 * Key test scenarios:
 * 1. Message addition - Ensure messages are correctly added to the list
 * 2. Streaming response - Ensure streaming content is appended chunk by chunk
 * 3. Thinking process - Ensure AI thinking process is handled correctly
 * 4. State management - Ensure loading states are updated correctly
 * 5. Message clearing - Ensure message list can be cleared correctly
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useMessageHandling, type TextMessage } from './useMessageHandling.js';

// Reference for storing hook results
interface HookResult {
  messages: TextMessage[];
  isStreaming: boolean;
  isWaitingForResponse: boolean;
  loadingMessage: string;
  addMessage: (message: TextMessage) => void;
  clearMessages: () => void;
  startStreaming: (timestamp?: number) => void;
  appendStreamChunk: (chunk: string) => void;
  endStreaming: () => void;
  breakAssistantSegment: () => void;
  appendThinkingChunk: (chunk: string) => void;
  clearThinking: () => void;
  setWaitingForResponse: (message: string) => void;
  clearWaitingForResponse: () => void;
  setMessages: (messages: TextMessage[]) => void;
}

// Test Harness component
function TestHarness({
  resultRef,
}: {
  resultRef: React.MutableRefObject<HookResult | null>;
}) {
  const hookResult = useMessageHandling();
  resultRef.current = hookResult;
  return null;
}

// Helper function to render hook
function renderMessageHandlingHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const resultRef: React.MutableRefObject<HookResult | null> = {
    current: null,
  };

  act(() => {
    root.render(<TestHarness resultRef={resultRef} />);
  });

  return {
    result: resultRef as React.MutableRefObject<HookResult>,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('useMessageHandling', () => {
  let rendered: {
    result: React.MutableRefObject<HookResult>;
    unmount: () => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    rendered = renderMessageHandlingHook();
  });

  afterEach(() => {
    rendered.unmount();
    vi.restoreAllMocks();
  });

  describe('Initial State', () => {
    /**
     * Test: Initial state
     *
     * Verifies hook initializes with correct state.
     * Ensures no unexpected initial messages or states.
     */
    it('should have correct initial state', () => {
      expect(rendered.result.current.messages).toEqual([]);
      expect(rendered.result.current.isStreaming).toBe(false);
      expect(rendered.result.current.isWaitingForResponse).toBe(false);
      expect(rendered.result.current.loadingMessage).toBe('');
    });
  });

  describe('addMessage - Message addition', () => {
    /**
     * Test: Add user message
     *
     * Verifies user messages are correctly added to message list.
     */
    it('should add user message', () => {
      const message: TextMessage = {
        role: 'user',
        content: 'Hello, AI!',
        timestamp: Date.now(),
      };

      act(() => {
        rendered.result.current.addMessage(message);
      });

      expect(rendered.result.current.messages).toHaveLength(1);
      expect(rendered.result.current.messages[0].role).toBe('user');
      expect(rendered.result.current.messages[0].content).toBe('Hello, AI!');
    });

    /**
     * Test: Add AI response
     *
     * Verifies AI responses are correctly added to message list.
     */
    it('should add assistant message', () => {
      const message: TextMessage = {
        role: 'assistant',
        content: 'Hello! How can I help?',
        timestamp: Date.now(),
      };

      act(() => {
        rendered.result.current.addMessage(message);
      });

      expect(rendered.result.current.messages).toHaveLength(1);
      expect(rendered.result.current.messages[0].role).toBe('assistant');
    });

    /**
     * Test: Add message with file context
     *
     * Verifies messages can include file context information.
     */
    it('should add message with file context', () => {
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
        rendered.result.current.addMessage(message);
      });

      expect(rendered.result.current.messages[0].fileContext).toBeDefined();
      expect(rendered.result.current.messages[0].fileContext?.fileName).toBe(
        'test.ts',
      );
    });

    /**
     * Test: Message order
     *
     * Verifies multiple messages maintain addition order.
     */
    it('should maintain message order', () => {
      act(() => {
        rendered.result.current.addMessage({
          role: 'user',
          content: 'First',
          timestamp: Date.now(),
        });
        rendered.result.current.addMessage({
          role: 'assistant',
          content: 'Second',
          timestamp: Date.now(),
        });
        rendered.result.current.addMessage({
          role: 'user',
          content: 'Third',
          timestamp: Date.now(),
        });
      });

      expect(rendered.result.current.messages).toHaveLength(3);
      expect(rendered.result.current.messages[0].content).toBe('First');
      expect(rendered.result.current.messages[1].content).toBe('Second');
      expect(rendered.result.current.messages[2].content).toBe('Third');
    });
  });

  describe('Streaming - Streaming response', () => {
    /**
     * Test: Start streaming response
     *
     * Verifies startStreaming correctly sets state and creates placeholder message.
     */
    it('should start streaming and create placeholder', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      expect(rendered.result.current.isStreaming).toBe(true);
      expect(rendered.result.current.messages).toHaveLength(1);
      expect(rendered.result.current.messages[0].role).toBe('assistant');
      expect(rendered.result.current.messages[0].content).toBe('');
    });

    /**
     * Test: Append streaming content
     *
     * Verifies streaming content is appended chunk by chunk to placeholder message.
     */
    it('should append stream chunks to placeholder', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('Hello');
        rendered.result.current.appendStreamChunk(' World');
        rendered.result.current.appendStreamChunk('!');
      });

      expect(rendered.result.current.messages[0].content).toBe('Hello World!');
    });

    /**
     * Test: Use provided timestamp
     *
     * Verifies startStreaming can use extension-provided timestamp for ordering.
     */
    it('should use provided timestamp for ordering', () => {
      const customTimestamp = 1000;

      act(() => {
        rendered.result.current.startStreaming(customTimestamp);
      });

      expect(rendered.result.current.messages[0].timestamp).toBe(
        customTimestamp,
      );
    });

    /**
     * Test: End streaming response
     *
     * Verifies endStreaming correctly resets state.
     */
    it('should end streaming correctly', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('Response content');
      });

      act(() => {
        rendered.result.current.endStreaming();
      });

      expect(rendered.result.current.isStreaming).toBe(false);
      expect(rendered.result.current.messages).toHaveLength(1);
      expect(rendered.result.current.messages[0].content).toBe(
        'Response content',
      );
    });

    /**
     * Test: Ignore late chunks after streaming ends
     *
     * Verifies late chunks are ignored after user cancels.
     */
    it('should ignore chunks after streaming ends', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('Hello');
      });

      act(() => {
        rendered.result.current.endStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk(' Late chunk');
      });

      expect(rendered.result.current.messages[0].content).toBe('Hello');
    });
  });

  describe('breakAssistantSegment - Segmented streaming response', () => {
    /**
     * Test: Break current stream segment
     *
     * Verifies current stream segment can be broken when tool call is inserted.
     */
    it('should break current segment and start new one on next chunk', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('Part 1');
      });

      act(() => {
        rendered.result.current.breakAssistantSegment();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('Part 2');
      });

      // Should have two assistant messages
      expect(rendered.result.current.messages).toHaveLength(2);
      expect(rendered.result.current.messages[0].content).toBe('Part 1');
      expect(rendered.result.current.messages[1].content).toBe('Part 2');
    });
  });

  describe('Thinking - Thinking process', () => {
    /**
     * Test: Append thinking content
     *
     * Verifies AI thinking process is correctly appended.
     */
    it('should append thinking chunks', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendThinkingChunk('Analyzing');
      });

      act(() => {
        rendered.result.current.appendThinkingChunk(' the code');
      });

      const thinkingMsg = rendered.result.current.messages.find(
        (m) => m.role === 'thinking',
      );
      expect(thinkingMsg).toBeDefined();
      expect(thinkingMsg?.content).toBe('Analyzing the code');
    });

    /**
     * Test: Remove thinking message on stream end
     *
     * Verifies thinking message is removed after streaming ends.
     */
    it('should remove thinking message on end streaming', () => {
      act(() => {
        rendered.result.current.startStreaming();
        rendered.result.current.appendThinkingChunk('Thinking...');
        rendered.result.current.appendStreamChunk('Response');
        rendered.result.current.endStreaming();
      });

      const thinkingMsg = rendered.result.current.messages.find(
        (m) => m.role === 'thinking',
      );
      expect(thinkingMsg).toBeUndefined();
    });

    /**
     * Test: Manually clear thinking message
     *
     * Verifies clearThinking correctly removes thinking message.
     */
    it('should clear thinking message manually', () => {
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendThinkingChunk('Thinking...');
      });

      expect(
        rendered.result.current.messages.find((m) => m.role === 'thinking'),
      ).toBeDefined();

      act(() => {
        rendered.result.current.clearThinking();
      });

      expect(
        rendered.result.current.messages.find((m) => m.role === 'thinking'),
      ).toBeUndefined();
    });

    /**
     * Test: Ignore thinking chunks after streaming ends
     *
     * Verifies late thinking content is ignored after user cancels.
     */
    it('should ignore thinking chunks after streaming ends', () => {
      act(() => {
        rendered.result.current.startStreaming();
        rendered.result.current.endStreaming();
      });

      act(() => {
        rendered.result.current.appendThinkingChunk('Late thinking');
      });

      expect(
        rendered.result.current.messages.find((m) => m.role === 'thinking'),
      ).toBeUndefined();
    });
  });

  describe('Loading State', () => {
    /**
     * Test: Set waiting for response state
     *
     * Verifies setWaitingForResponse correctly sets state and message.
     */
    it('should set waiting for response state', () => {
      act(() => {
        rendered.result.current.setWaitingForResponse('AI is thinking...');
      });

      expect(rendered.result.current.isWaitingForResponse).toBe(true);
      expect(rendered.result.current.loadingMessage).toBe('AI is thinking...');
    });

    /**
     * Test: Clear waiting for response state
     *
     * Verifies clearWaitingForResponse correctly resets state.
     */
    it('should clear waiting for response state', () => {
      act(() => {
        rendered.result.current.setWaitingForResponse('Loading...');
        rendered.result.current.clearWaitingForResponse();
      });

      expect(rendered.result.current.isWaitingForResponse).toBe(false);
      expect(rendered.result.current.loadingMessage).toBe('');
    });
  });

  describe('clearMessages - Message clearing', () => {
    /**
     * Test: Clear all messages
     *
     * Verifies clearMessages correctly clears message list.
     */
    it('should clear all messages', () => {
      act(() => {
        rendered.result.current.addMessage({
          role: 'user',
          content: 'Test 1',
          timestamp: Date.now(),
        });
        rendered.result.current.addMessage({
          role: 'assistant',
          content: 'Test 2',
          timestamp: Date.now(),
        });
      });

      expect(rendered.result.current.messages).toHaveLength(2);

      act(() => {
        rendered.result.current.clearMessages();
      });

      expect(rendered.result.current.messages).toHaveLength(0);
    });
  });

  describe('setMessages - Direct message setting', () => {
    /**
     * Test: Directly set message list
     *
     * Verifies entire message list can be replaced directly (for session restoration).
     */
    it('should set messages directly', () => {
      const messages: TextMessage[] = [
        { role: 'user', content: 'Hello', timestamp: 1000 },
        { role: 'assistant', content: 'Hi there!', timestamp: 1001 },
      ];

      act(() => {
        rendered.result.current.setMessages(messages);
      });

      expect(rendered.result.current.messages).toEqual(messages);
    });
  });

  describe('Edge Cases', () => {
    /**
     * Test: Handle empty content
     *
     * Verifies empty content handling doesn't cause issues.
     */
    it('should handle empty content', () => {
      act(() => {
        rendered.result.current.addMessage({
          role: 'user',
          content: '',
          timestamp: Date.now(),
        });
      });

      expect(rendered.result.current.messages[0].content).toBe('');
    });

    /**
     * Test: Handle many messages
     *
     * Verifies large number of messages can be handled without crashing.
     */
    it('should handle many messages', () => {
      act(() => {
        for (let i = 0; i < 100; i++) {
          rendered.result.current.addMessage({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${i}`,
            timestamp: Date.now() + i,
          });
        }
      });

      expect(rendered.result.current.messages).toHaveLength(100);
    });

    /**
     * Test: Handle rapid operations
     *
     * Verifies rapid consecutive operations don't cause state anomalies.
     */
    it('should handle rapid operations', () => {
      // First round of streaming
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('A');
        rendered.result.current.appendStreamChunk('B');
        rendered.result.current.appendStreamChunk('C');
      });

      act(() => {
        rendered.result.current.endStreaming();
      });

      // Second round of streaming
      act(() => {
        rendered.result.current.startStreaming();
      });

      act(() => {
        rendered.result.current.appendStreamChunk('D');
      });

      act(() => {
        rendered.result.current.endStreaming();
      });

      // Should have two assistant messages
      expect(rendered.result.current.messages).toHaveLength(2);
      expect(rendered.result.current.messages[0].content).toBe('ABC');
      expect(rendered.result.current.messages[1].content).toBe('D');
    });
  });
});
