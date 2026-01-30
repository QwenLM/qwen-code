/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { useSessions } from './hooks/useSessions.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useMessages } from './hooks/useMessages.js';
import type { Message, PermissionRequest } from '../shared/types.js';

export function App() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const { sessions, createSession, refreshSessions, isLoading } = useSessions();
  const { messages, addMessage, setMessages, clearMessages } = useMessages();

  const handleMessage = useCallback(
    (msg: Message) => {
      addMessage(msg);
    },
    [addMessage],
  );

  const handleHistory = useCallback(
    (history: Message[]) => {
      setMessages(history);
    },
    [setMessages],
  );

  const {
    send,
    isConnected,
    isStreaming,
    permissionRequest,
    respondToPermission,
  } = useWebSocket(currentSessionId, {
    onMessage: handleMessage,
    onHistory: handleHistory,
  });

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setCurrentSessionId(sessionId);
      clearMessages();
    },
    [clearMessages],
  );

  const handleCreateSession = useCallback(async () => {
    const newSession = await createSession();
    if (newSession) {
      setCurrentSessionId(newSession.id);
      clearMessages();
    }
  }, [createSession, clearMessages]);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!currentSessionId || !content.trim()) return;
      send({ type: 'user_message', content });
    },
    [currentSessionId, send],
  );

  const handleCancel = useCallback(() => {
    send({ type: 'cancel' });
  }, [send]);

  const handlePermissionResponse = useCallback(
    (allow: boolean, scope: string) => {
      respondToPermission(allow, scope);
    },
    [respondToPermission],
  );

  return (
    <div className="flex h-screen bg-[var(--app-primary-background)]">
      {/* Sidebar */}
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        onRefresh={refreshSessions}
        isLoading={isLoading}
      />

      {/* Main content */}
      <ChatArea
        sessionId={currentSessionId}
        messages={messages}
        isConnected={isConnected}
        isStreaming={isStreaming}
        permissionRequest={permissionRequest}
        onSendMessage={handleSendMessage}
        onCancel={handleCancel}
        onPermissionResponse={handlePermissionResponse}
      />
    </div>
  );
}
