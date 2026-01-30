/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useMemo, useCallback } from 'react';
import { ChatViewer } from '@qwen-code/webui';
import type { ChatViewerHandle, ChatMessageData } from '@qwen-code/webui';
import type { Message, PermissionRequest } from '../../shared/types.js';

interface ChatAreaProps {
  sessionId: string | null;
  messages: Message[];
  isConnected: boolean;
  isStreaming: boolean;
  permissionRequest: PermissionRequest | null;
  onSendMessage: (content: string) => void;
  onCancel: () => void;
  onPermissionResponse: (allow: boolean, scope: string) => void;
}

export function ChatArea({
  sessionId,
  messages,
  isConnected,
  isStreaming,
  permissionRequest,
  onSendMessage,
  onCancel,
  onPermissionResponse,
}: ChatAreaProps) {
  const chatViewerRef = useRef<ChatViewerHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputText, setInputText] = useState('');

  // Convert messages to ChatViewer format
  const chatMessages: ChatMessageData[] = useMemo(() => {
    return messages.map((msg) => ({
      uuid: msg.uuid,
      parentUuid: msg.parentUuid,
      timestamp: msg.timestamp,
      type: msg.type as ChatMessageData['type'],
      message: msg.message
        ? {
            role: msg.message.role,
            parts: msg.message.parts,
            content: msg.message.content,
          }
        : undefined,
      toolCall: msg.toolCall
        ? {
            kind: msg.toolCall.name,
            name: msg.toolCall.name,
            args: msg.toolCall.args,
            status: msg.toolCall.status,
            result: msg.toolCall.result,
          }
        : undefined,
    }));
  }, [messages]);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!inputText.trim() || isStreaming) return;
      onSendMessage(inputText);
      setInputText('');
    },
    [inputText, isStreaming, onSendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === 'Escape' && isStreaming) {
        onCancel();
      }
    },
    [handleSubmit, isStreaming, onCancel],
  );

  // Empty state
  if (!sessionId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-[var(--app-primary-background)]">
        <div className="text-center text-[var(--app-secondary-foreground)]">
          <div className="text-6xl mb-4 opacity-30">💬</div>
          <h2 className="text-xl font-medium mb-2">Welcome to Qwen Code</h2>
          <p className="text-sm">
            Select a session or create a new one to get started
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col bg-[var(--app-primary-background)] relative">
      {/* Header */}
      <header className="px-4 py-3 border-b border-[var(--app-border)] flex items-center justify-between bg-[var(--app-secondary-background)]">
        <div>
          <h2 className="font-medium text-[var(--app-primary-foreground)]">
            Session
          </h2>
          <span className="text-xs text-[var(--app-secondary-foreground)]">
            {sessionId.slice(0, 8)}...
          </span>
        </div>
        <div className="flex items-center gap-3">
          {!isConnected && (
            <span className="text-xs text-red-500 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              Disconnected
            </span>
          )}
          {isConnected && (
            <span className="text-xs text-green-500 flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              Connected
            </span>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-hidden">
        <ChatViewer
          ref={chatViewerRef}
          messages={chatMessages}
          autoScroll={true}
          theme="auto"
          emptyMessage="Start a conversation..."
          showEmptyIcon={true}
        />
      </div>

      {/* Input area */}
      <div className="p-4 border-t border-[var(--app-border)] bg-[var(--app-secondary-background)]">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Qwen Code..."
              disabled={!isConnected}
              rows={1}
              className="w-full px-4 py-3 rounded-lg bg-[var(--app-input-background)] text-[var(--app-primary-foreground)] placeholder:text-[var(--app-input-placeholder-foreground)] border border-[var(--app-border)] focus:border-[var(--app-button-background)] focus:outline-none resize-none"
              style={{
                minHeight: '48px',
                maxHeight: '200px',
              }}
            />
          </div>
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors flex items-center gap-2"
              title="Stop generation"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputText.trim() || !isConnected}
              className="px-4 py-2 rounded-lg bg-[var(--app-button-background)] text-[var(--app-button-foreground)] hover:bg-[var(--app-button-hover-background)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              title="Send message"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
              Send
            </button>
          )}
        </form>
        <div className="mt-2 text-xs text-[var(--app-secondary-foreground)]">
          Press Enter to send, Shift+Enter for new line
        </div>
      </div>

      {/* Permission request modal */}
      {permissionRequest && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--app-menu-background)] rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-medium mb-4 text-[var(--app-primary-foreground)]">
              Permission Request
            </h3>
            <p className="text-sm text-[var(--app-secondary-foreground)] mb-4">
              {permissionRequest.description ||
                `Allow ${permissionRequest.operation}?`}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => onPermissionResponse(false, '')}
                className="px-4 py-2 rounded bg-[var(--app-input-background)] text-[var(--app-primary-foreground)] hover:bg-[var(--app-list-hover-background)]"
              >
                Deny
              </button>
              <button
                onClick={() => onPermissionResponse(true, 'once')}
                className="px-4 py-2 rounded bg-[var(--app-button-background)] text-[var(--app-button-foreground)] hover:bg-[var(--app-button-hover-background)]"
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
