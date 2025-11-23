/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { useVSCode } from './hooks/useVSCode.js';
import type { ChatMessage } from '../agents/QwenAgentManager.js';
import type { Conversation } from '../storage/ConversationStore.js';

export const App: React.FC = () => {
  const vscode = useVSCode();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentStreamContent, setCurrentStreamContent] = useState('');
  const [qwenSessions, setQwenSessions] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handlePermissionRequest = React.useCallback(
    (request: {
      options: Array<{ name: string; kind: string; optionId: string }>;
      toolCall: { title?: string };
    }) => {
      const optionNames = request.options.map((opt) => opt.name).join(', ');
      const confirmed = window.confirm(
        `Tool permission request:\n${request.toolCall.title || 'Tool Call'}\n\nOptions: ${optionNames}\n\nAllow?`,
      );

      const selectedOption = confirmed
        ? request.options.find((opt) => opt.kind === 'allow_once')
        : request.options.find((opt) => opt.kind === 'reject_once');

      vscode.postMessage({
        type: 'permissionResponse',
        data: { optionId: selectedOption?.optionId || 'reject_once' },
      });
    },
    [vscode],
  );

  useEffect(() => {
    // Listen for messages from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case 'conversationLoaded': {
          const conversation = message.data as Conversation;
          setMessages(conversation.messages);
          break;
        }

        case 'message': {
          const newMessage = message.data as ChatMessage;
          setMessages((prev) => [...prev, newMessage]);
          break;
        }

        case 'streamStart':
          setIsStreaming(true);
          setCurrentStreamContent('');
          break;

        case 'streamChunk':
          setCurrentStreamContent((prev) => prev + message.data.chunk);
          break;

        case 'streamEnd':
          // Finalize the streamed message
          if (currentStreamContent) {
            const assistantMessage: ChatMessage = {
              role: 'assistant',
              content: currentStreamContent,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, assistantMessage]);
          }
          setIsStreaming(false);
          setCurrentStreamContent('');
          break;

        case 'error':
          console.error('Error from extension:', message.data.message);
          setIsStreaming(false);
          break;

        case 'permissionRequest':
          // Show permission dialog
          handlePermissionRequest(message.data);
          break;

        case 'qwenSessionList':
          setQwenSessions(message.data.sessions || []);
          break;

        case 'qwenSessionSwitched':
          setShowSessionSelector(false);
          // Load messages from the session
          if (message.data.messages) {
            setMessages(message.data.messages);
          } else {
            setMessages([]);
          }
          setCurrentStreamContent('');
          break;

        case 'conversationCleared':
          setMessages([]);
          setCurrentStreamContent('');
          break;

        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [currentStreamContent, handlePermissionRequest]);

  useEffect(() => {
    // Auto-scroll to bottom when messages change
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStreamContent]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!inputText.trim() || isStreaming) {
      console.log('Submit blocked:', { inputText, isStreaming });
      return;
    }

    console.log('Sending message:', inputText);
    vscode.postMessage({
      type: 'sendMessage',
      data: { text: inputText },
    });

    setInputText('');
  };

  const handleLoadQwenSessions = () => {
    vscode.postMessage({ type: 'getQwenSessions', data: {} });
    setShowSessionSelector(true);
  };

  const handleNewQwenSession = () => {
    vscode.postMessage({ type: 'newQwenSession', data: {} });
    setShowSessionSelector(false);
    // Clear messages in UI
    setMessages([]);
    setCurrentStreamContent('');
  };

  const handleSwitchSession = (sessionId: string) => {
    vscode.postMessage({
      type: 'switchQwenSession',
      data: { sessionId },
    });
  };

  return (
    <div className="chat-container">
      {showSessionSelector && (
        <div className="session-selector-overlay">
          <div className="session-selector">
            <div className="session-selector-header">
              <h3>Qwen Sessions</h3>
              <button onClick={() => setShowSessionSelector(false)}>✕</button>
            </div>
            <div className="session-selector-actions">
              <button
                className="new-session-button"
                onClick={handleNewQwenSession}
              >
                ➕ New Session
              </button>
            </div>
            <div className="session-list">
              {qwenSessions.length === 0 ? (
                <p className="no-sessions">No sessions available</p>
              ) : (
                qwenSessions.map((session) => {
                  const sessionId =
                    (session.id as string) ||
                    (session.sessionId as string) ||
                    '';
                  const title =
                    (session.title as string) ||
                    (session.name as string) ||
                    'Untitled Session';
                  const lastUpdated =
                    (session.lastUpdated as string) ||
                    (session.startTime as string) ||
                    '';
                  const messageCount = (session.messageCount as number) || 0;

                  return (
                    <div
                      key={sessionId}
                      className="session-item"
                      onClick={() => handleSwitchSession(sessionId)}
                    >
                      <div className="session-title">{title}</div>
                      <div className="session-meta">
                        <span className="session-time">
                          {new Date(lastUpdated).toLocaleString()}
                        </span>
                        <span className="session-count">
                          {messageCount} messages
                        </span>
                      </div>
                      <div className="session-id">
                        {sessionId.substring(0, 8)}...
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      <div className="chat-header">
        <button className="session-button" onClick={handleLoadQwenSessions}>
          📋 Sessions
        </button>
      </div>

      <div className="messages-container">
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.role}`}>
            <div className="message-content">{msg.content}</div>
            <div className="message-timestamp">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}

        {isStreaming && currentStreamContent && (
          <div className="message assistant streaming">
            <div className="message-content">{currentStreamContent}</div>
            <div className="streaming-indicator">●</div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="input-field"
          placeholder="Type your message..."
          value={inputText}
          onChange={(e) => setInputText((e.target as HTMLInputElement).value)}
          disabled={isStreaming}
        />
        <button
          type="submit"
          className="send-button"
          disabled={isStreaming || !inputText.trim()}
        >
          Send
        </button>
      </form>
    </div>
  );
};
