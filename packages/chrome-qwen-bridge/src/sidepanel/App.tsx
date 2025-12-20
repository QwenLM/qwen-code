/**
 * Chrome Extension Side Panel App
 * Simplified version adapted from vscode-ide-companion
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useVSCode } from './hooks/useVSCode.js';
import { InputForm } from './components/layout/InputForm.js';
import { EmptyState } from './components/layout/EmptyState.js';
import {
  UserMessage,
  AssistantMessage,
  WaitingMessage,
} from './components/messages/index.js';
import { PermissionDrawer } from './components/PermissionDrawer/PermissionDrawer.js';
import type { PermissionOption, ToolCall } from './components/PermissionDrawer/PermissionRequest.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export const App: React.FC = () => {
  const vscode = useVSCode();

  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [permissionRequest, setPermissionRequest] = useState<{
    requestId: number;
    options: PermissionOption[];
    toolCall: ToolCall;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputFieldRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Listen for messages from background script
  useEffect(() => {
    const handleMessage = (message: { type: string; data?: unknown }) => {
      console.log('[App] Received message:', message);

      switch (message.type) {
        case 'STATUS_UPDATE':
          setIsConnected((message as { status: string }).status !== 'disconnected');
          break;

        case 'streamStart':
          setIsStreaming(true);
          setIsWaitingForResponse(false);
          setStreamingContent('');
          break;

        case 'streamChunk':
          setStreamingContent(prev => prev + ((message as { data: { chunk: string } }).data?.chunk || ''));
          break;

        case 'streamEnd':
          if (streamingContent) {
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: streamingContent,
              timestamp: Date.now(),
            }]);
          }
          setIsStreaming(false);
          setStreamingContent('');
          break;

        case 'message':
          const msgData = (message as { data: Message }).data;
          if (msgData) {
            setMessages(prev => [...prev, {
              role: msgData.role,
              content: msgData.content,
              timestamp: msgData.timestamp || Date.now(),
            }]);
          }
          break;

        case 'error':
          setIsStreaming(false);
          setIsWaitingForResponse(false);
          setLoadingMessage(null);
          break;

        case 'permissionRequest':
          // Handle permission request from Qwen CLI
          console.log('[App] Permission request:', message);
          const permData = (message as { data: { requestId: number; options: PermissionOption[]; toolCall: ToolCall } }).data;
          if (permData) {
            setPermissionRequest({
              requestId: permData.requestId,
              options: permData.options,
              toolCall: permData.toolCall,
            });
          }
          break;
      }
    };

    // Add Chrome message listener
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener(handleMessage);
      return () => {
        chrome.runtime.onMessage.removeListener(handleMessage);
      };
    }
  }, [streamingContent]);

  // Check connection status on mount
  useEffect(() => {
    const checkStatus = async () => {
      const response = await vscode.postMessage({ type: 'GET_STATUS' }) as { connected?: boolean; status?: string } | null;
      if (response) {
        setIsConnected(response.connected || false);
      }
    };
    checkStatus();
  }, [vscode]);

  // Handle submit
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    const text = inputText.trim();
    if (!text || isStreaming || isWaitingForResponse) return;

    // Add user message
    setMessages(prev => [...prev, {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }]);

    // Clear input
    setInputText('');
    if (inputFieldRef.current) {
      inputFieldRef.current.textContent = '';
    }

    // Send to background
    setIsWaitingForResponse(true);
    setLoadingMessage('Thinking...');

    await vscode.postMessage({
      type: 'sendMessage',
      data: { text },
    });
  }, [inputText, isStreaming, isWaitingForResponse, vscode]);

  // Handle cancel
  const handleCancel = useCallback(async () => {
    await vscode.postMessage({ type: 'cancelStreaming', data: {} });
    setIsStreaming(false);
    setIsWaitingForResponse(false);
    setLoadingMessage(null);
  }, [vscode]);

  // Handle connect
  const handleConnect = useCallback(async () => {
    setLoadingMessage('Connecting...');
    const response = await vscode.postMessage({ type: 'CONNECT' }) as { success?: boolean; status?: string } | null;
    if (response?.success) {
      setIsConnected(true);
      setLoadingMessage(null);
    } else {
      setLoadingMessage('Connection failed');
      setTimeout(() => setLoadingMessage(null), 3000);
    }
  }, [vscode]);

  // Handle permission response
  const handlePermissionResponse = useCallback((optionId: string) => {
    if (!permissionRequest) return;

    console.log('[App] Sending permission response:', optionId, 'for requestId:', permissionRequest.requestId);
    vscode.postMessage({
      type: 'permissionResponse',
      data: {
        requestId: permissionRequest.requestId,
        optionId,
      },
    });
    setPermissionRequest(null);
  }, [vscode, permissionRequest]);

  const hasContent = messages.length > 0 || isStreaming || streamingContent;

  return (
    <div className="chat-container relative flex flex-col h-screen bg-[#1e1e1e] text-white">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h1 className="text-sm font-medium">Qwen Code</h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-gray-500'}`} />
          <span className="text-xs text-gray-400">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        {!hasContent ? (
          <EmptyState
            isAuthenticated={isConnected}
            loadingMessage={!isConnected ? 'Click Connect to start' : undefined}
          />
        ) : (
          <>
            {messages.map((msg, index) => (
              msg.role === 'user' ? (
                <UserMessage
                  key={index}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  onFileClick={() => {}}
                />
              ) : (
                <AssistantMessage
                  key={index}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  onFileClick={() => {}}
                />
              )
            ))}

            {/* Streaming message */}
            {isStreaming && streamingContent && (
              <AssistantMessage
                content={streamingContent}
                timestamp={Date.now()}
                onFileClick={() => {}}
              />
            )}

            {/* Waiting indicator */}
            {isWaitingForResponse && loadingMessage && (
              <WaitingMessage loadingMessage={loadingMessage} />
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      {isConnected ? (
        <InputForm
          inputText={inputText}
          inputFieldRef={inputFieldRef}
          isStreaming={isStreaming}
          isWaitingForResponse={isWaitingForResponse}
          isComposing={false}
          editMode="default"
          thinkingEnabled={false}
          activeFileName={null}
          activeSelection={null}
          skipAutoActiveContext={true}
          onInputChange={setInputText}
          onCompositionStart={() => {}}
          onCompositionEnd={() => {}}
          onKeyDown={() => {}}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onToggleEditMode={() => {}}
          onToggleThinking={() => {}}
          onFocusActiveEditor={() => {}}
          onToggleSkipAutoActiveContext={() => {}}
          onShowCommandMenu={() => {}}
          onAttachContext={() => {}}
          completionIsOpen={false}
          completionItems={[]}
          onCompletionSelect={() => {}}
          onCompletionClose={() => {}}
        />
      ) : (
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleConnect}
            className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 rounded text-white text-sm font-medium transition-colors"
          >
            Connect to Qwen CLI
          </button>
        </div>
      )}

      {/* Permission Request Drawer */}
      {permissionRequest && (
        <PermissionDrawer
          isOpen={!!permissionRequest}
          options={permissionRequest.options}
          toolCall={permissionRequest.toolCall}
          onResponse={handlePermissionResponse}
          onClose={() => setPermissionRequest(null)}
        />
      )}
    </div>
  );
};
