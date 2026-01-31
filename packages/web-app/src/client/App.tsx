/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { ChatArea } from './components/ChatArea.js';
import { useSessions } from './hooks/useSessions.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useMessages } from './hooks/useMessages.js';
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from './components/ui/resizable.js';
import type { Message } from '../shared/types.js';

// App version - dynamically imported from generated file
import { APP_VERSION } from './version.js';

type Theme = 'light' | 'dark' | 'system';

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const effectiveTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;

  if (effectiveTheme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export function App() {
  // Initialize session ID from URL hash
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    () => {
      const hash = window.location.hash.slice(1); // Remove '#'
      return hash || null;
    },
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('qwen-code-theme') as Theme | null;
    return saved || 'system';
  });

  // Sync session ID to URL hash
  useEffect(() => {
    if (currentSessionId) {
      window.history.replaceState(null, '', `#${currentSessionId}`);
    } else {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [currentSessionId]);

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('qwen-code-theme', theme);
  }, [theme]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        applyTheme('system');
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const { sessions, createSession, deleteSession, refreshSessions, isLoading } =
    useSessions();
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
    sessionInfo,
    usage,
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
    (optionId: string) => {
      respondToPermission(optionId);
    },
    [respondToPermission],
  );

  const handleToggleTheme = useCallback(() => {
    setTheme((current) => {
      if (current === 'light') return 'dark';
      if (current === 'dark') return 'system';
      return 'light';
    });
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      const success = await deleteSession(sessionId);
      if (success && currentSessionId === sessionId) {
        setCurrentSessionId(null);
        clearMessages();
      }
    },
    [deleteSession, currentSessionId, clearMessages],
  );

  // Find current session for header display
  const currentSession = sessions.find((s) => s.id === currentSessionId);

  // Get previous/next session for navigation
  const currentIndex = sessions.findIndex((s) => s.id === currentSessionId);
  const hasPrevSession = currentIndex > 0;
  const hasNextSession =
    currentIndex >= 0 && currentIndex < sessions.length - 1;

  const handlePrevSession = useCallback(() => {
    if (hasPrevSession) {
      const prevSession = sessions[currentIndex - 1];
      handleSelectSession(prevSession.id);
    }
  }, [hasPrevSession, sessions, currentIndex, handleSelectSession]);

  const handleNextSession = useCallback(() => {
    if (hasNextSession) {
      const nextSession = sessions[currentIndex + 1];
      handleSelectSession(nextSession.id);
    }
  }, [hasNextSession, sessions, currentIndex, handleSelectSession]);

  // Use CLI version if available, fallback to APP_VERSION
  const displayVersion = sessionInfo?.version || APP_VERSION;

  return (
    <div className="h-screen bg-background">
      <ResizablePanelGroup direction="horizontal" className="h-full">
        {/* Sidebar Panel */}
        <ResizablePanel
          defaultSize={sidebarCollapsed ? 3 : 20}
          minSize={sidebarCollapsed ? 3 : 15}
          maxSize={sidebarCollapsed ? 3 : 30}
          className="border-r border-border"
        >
          <Sidebar
            sessions={sessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onCreateSession={handleCreateSession}
            onDeleteSession={handleDeleteSession}
            onRefresh={refreshSessions}
            isLoading={isLoading}
            collapsed={sidebarCollapsed}
            onToggleCollapse={handleToggleSidebar}
            theme={theme}
            onToggleTheme={handleToggleTheme}
            version={displayVersion}
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* Main content Panel */}
        <ResizablePanel defaultSize={80} minSize={50}>
          <ChatArea
            sessionId={currentSessionId}
            sessionTitle={currentSession?.title}
            sessionTime={currentSession?.lastUpdated}
            messages={messages}
            isConnected={isConnected}
            isStreaming={isStreaming}
            permissionRequest={permissionRequest}
            onSendMessage={handleSendMessage}
            onCancel={handleCancel}
            onPermissionResponse={handlePermissionResponse}
            onPrevSession={hasPrevSession ? handlePrevSession : undefined}
            onNextSession={hasNextSession ? handleNextSession : undefined}
            theme={
              theme === 'system'
                ? window.matchMedia('(prefers-color-scheme: dark)').matches
                  ? 'dark'
                  : 'light'
                : theme
            }
            usage={usage}
            currentModel={sessionInfo?.model}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
