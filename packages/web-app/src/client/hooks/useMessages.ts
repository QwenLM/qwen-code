/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Message } from '../../shared/types.js';

interface UseMessagesReturn {
  messages: Message[];
  addMessage: (message: Message) => void;
  updateMessage: (uuid: string, updates: Partial<Message>) => void;
  setMessages: (messages: Message[]) => void;
  clearMessages: () => void;
}

export function useMessages(): UseMessagesReturn {
  const [messages, setMessages] = useState<Message[]>([]);

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => {
      // Check if message already exists (by uuid)
      const exists = prev.some((m) => m.uuid === message.uuid);
      if (exists) {
        // Update existing message
        return prev.map((m) =>
          m.uuid === message.uuid ? { ...m, ...message } : m,
        );
      }
      // Add new message
      return [...prev, message];
    });
  }, []);

  const updateMessage = useCallback(
    (uuid: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.uuid === uuid ? { ...m, ...updates } : m)),
      );
    },
    [],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    addMessage,
    updateMessage,
    setMessages,
    clearMessages,
  };
}
