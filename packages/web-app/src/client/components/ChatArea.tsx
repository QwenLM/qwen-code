/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { ChatViewer, WaitingMessage } from '@qwen-code/webui';
import type { ChatViewerHandle, ChatMessageData } from '@qwen-code/webui';
import {
  Info,
  ChevronUp,
  ChevronDown,
  Paperclip,
  Settings,
  Maximize2,
  Square,
  Send,
  X,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Button } from './ui/button.js';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from './ui/tooltip.js';
import type { Message, PermissionRequest } from '../../shared/types.js';
const qwenCodeLogo = new URL('../assets/icon.png', import.meta.url).href;

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow: number;
}

interface ChatAreaProps {
  sessionId: string | null;
  sessionTitle?: string;
  sessionTime?: string;
  messages: Message[];
  isConnected: boolean;
  isStreaming: boolean;
  permissionRequest: PermissionRequest | null;
  onSendMessage: (
    content: string,
    options?: { model?: string; thinking?: boolean },
  ) => void;
  onCancel: () => void;
  onPermissionResponse: (optionId: string) => void;
  onPrevSession?: () => void;
  onNextSession?: () => void;
  theme?: 'light' | 'dark';
  usage?: UsageInfo | null;
  currentModel?: string;
}

export function ChatArea({
  sessionId,
  sessionTitle,
  sessionTime,
  messages,
  isConnected,
  isStreaming,
  permissionRequest,
  onSendMessage,
  onCancel,
  onPermissionResponse,
  onPrevSession,
  onNextSession,
  theme = 'light',
  usage,
  currentModel,
}: ChatAreaProps) {
  const chatViewerRef = useRef<ChatViewerHandle>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSessionIdRef = useRef<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [inputExpanded, setInputExpanded] = useState(false);

  // Calculate context usage from real usage data or estimate from messages
  const contextUsage = useMemo(() => {
    if (usage && usage.contextWindow > 0) {
      const percentage = Math.min(
        100,
        Math.round((usage.totalTokens / usage.contextWindow) * 100),
      );
      return percentage;
    }
    // Fallback: estimate from message content
    const totalChars = messages.reduce((sum, msg) => {
      const content = msg.message?.content;
      if (typeof content === 'string') return sum + content.length;
      // Also count from parts
      const parts = msg.message?.parts;
      if (Array.isArray(parts)) {
        return (
          sum +
          parts.reduce((partSum, part) => {
            if (part && typeof part.text === 'string') {
              return partSum + part.text.length;
            }
            return partSum;
          }, 0)
        );
      }
      return sum;
    }, 0);
    const estimatedTokens = Math.round(totalChars / 4);
    const maxTokens = 200000;
    const percentage = Math.min(
      100,
      Math.round((estimatedTokens / maxTokens) * 100),
    );
    return percentage;
  }, [messages, usage]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea && !inputExpanded) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [inputText, inputExpanded]);

  // Scroll to bottom helper
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop =
          scrollContainerRef.current.scrollHeight;
      }
    });
  }, []);

  // Scroll to bottom when messages change (new message added or streaming)
  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming, scrollToBottom]);

  // Scroll to bottom on initial load (for sessions loaded from URL hash)
  useEffect(() => {
    if (!sessionId) {
      lastSessionIdRef.current = null;
      return;
    }
    if (messages.length === 0) return;
    if (lastSessionIdRef.current === sessionId) return;
    lastSessionIdRef.current = sessionId;
    // Small delay to ensure DOM is rendered
    const timer = setTimeout(scrollToBottom, 100);
    return () => clearTimeout(timer);
  }, [sessionId, messages.length, scrollToBottom]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        const fileNames = Array.from(files)
          .map((f) => `@${f.name}`)
          .join(' ');
        setInputText((prev) => prev + (prev ? ' ' : '') + fileNames);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [],
  );

  const normalizeContent = (
    content: Message['message'] | undefined,
  ): NonNullable<ChatMessageData['message']>['content'] => {
    const raw = content?.content;
    if (!Array.isArray(raw)) {
      return raw;
    }
    return raw.filter(
      (item): item is { type: string } =>
        typeof item === 'object' && item !== null && 'type' in item,
    ) as NonNullable<ChatMessageData['message']>['content'];
  };

  // Convert messages to ChatViewer format
  const chatMessages: ChatMessageData[] = useMemo(
    () =>
      messages.map((msg) => ({
        uuid: msg.uuid,
        parentUuid: msg.parentUuid,
        timestamp: msg.timestamp,
        type: (msg.type === 'thinking'
          ? 'assistant'
          : msg.type) as ChatMessageData['type'],
        message: msg.message
          ? {
              role:
                msg.type === 'thinking'
                  ? 'thinking'
                  : msg.message.role || msg.type,
              parts: msg.message.parts,
              content: normalizeContent(msg.message),
            }
          : undefined,
        toolCall: msg.toolCall ?? undefined,
      })),
    [messages],
  );

  // Check if we have any assistant response after the last user message
  const hasAssistantResponse = useMemo(() => {
    if (messages.length === 0) return false;
    // Find the last user message index
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return true; // No user message, no need to show loading
    // Check if there's any assistant/thinking/tool_call after the last user message
    for (let i = lastUserIndex + 1; i < messages.length; i++) {
      const type = messages[i].type;
      if (type === 'assistant' || type === 'thinking' || type === 'tool_call') {
        return true;
      }
    }
    return false;
  }, [messages]);

  const handleSubmit = useCallback(
    (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.();
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
      <main className="flex-1 flex items-center justify-center bg-background h-full">
        <div className="text-center text-muted-foreground">
          <img
            src={qwenCodeLogo}
            alt="Qwen Code"
            className="w-16 h-16 mx-auto mb-4 rounded-2xl"
          />
          <h2 className="text-xl font-medium mb-2 text-foreground">
            Welcome to Qwen Code
          </h2>
          <p className="text-sm">
            Select a session or create a new one to get started
          </p>
        </div>
      </main>
    );
  }

  const displayTitle = sessionTitle || 'Session';
  const displayModel = currentModel || 'Default Model';

  return (
    <TooltipProvider>
      <main className="flex-1 flex flex-col bg-background relative h-full">
        {/* Header */}
        <header className="px-6 py-3 border-b border-border flex items-center justify-between bg-background shrink-0">
          <div className="flex-1 min-w-0 mr-4">
            <h2 className="font-semibold text-foreground text-base truncate">
              {displayTitle}
            </h2>
            {sessionTime && (
              <span className="text-xs text-muted-foreground">
                {new Date(sessionTime).toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Info icon */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-1.5 rounded-md hover:bg-accent transition-colors"
                  type="button"
                >
                  <Info className="h-4 w-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <div className="text-xs">
                  <div className="font-medium mb-1">Session ID</div>
                  <code className="text-[10px] bg-muted px-1 py-0.5 rounded">
                    {sessionId}
                  </code>
                </div>
              </TooltipContent>
            </Tooltip>

            {/* Session navigation */}
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onPrevSession}
                    disabled={!onPrevSession}
                    className="p-1.5 rounded-md hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    type="button"
                  >
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Previous session</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onNextSession}
                    disabled={!onNextSession}
                    className="p-1.5 rounded-md hover:bg-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    type="button"
                  >
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Next session</TooltipContent>
              </Tooltip>
            </div>

            {/* Context usage */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-xs text-muted-foreground cursor-default">
                  {contextUsage}% context
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {usage ? (
                  <div className="text-xs">
                    <div>
                      Input: {usage.inputTokens.toLocaleString()} tokens
                    </div>
                    <div>
                      Output: {usage.outputTokens.toLocaleString()} tokens
                    </div>
                    <div>
                      Total: {usage.totalTokens.toLocaleString()} /{' '}
                      {usage.contextWindow.toLocaleString()}
                    </div>
                  </div>
                ) : (
                  'Estimated context usage'
                )}
              </TooltipContent>
            </Tooltip>

            {/* Connection status */}
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  'w-2 h-2 rounded-full',
                  isConnected ? 'bg-green-500' : 'bg-red-500',
                )}
              />
              <span
                className={cn(
                  'text-xs font-medium',
                  isConnected ? 'text-green-500' : 'text-red-500',
                )}
              >
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-auto" ref={scrollContainerRef}>
          <div
            className={cn(
              'h-full flex flex-col',
              chatMessages.length === 0 && 'items-center justify-center',
            )}
          >
            <div
              className={cn(
                chatMessages.length === 0
                  ? 'flex items-center justify-center'
                  : 'flex-1',
              )}
            >
              <ChatViewer
                ref={chatViewerRef}
                messages={chatMessages}
                autoScroll={false}
                theme={theme}
                emptyMessage="Start a conversation..."
                showEmptyIcon={true}
              />
            </div>
            {/* Show waiting message when streaming starts but no assistant response yet */}
            {isStreaming && !hasAssistantResponse && (
              <div className="px-6 py-2">
                <WaitingMessage loadingMessage="Thinking..." />
              </div>
            )}
            {/* Bottom padding for scroll space */}
            <div className="h-4 shrink-0" />
          </div>
        </div>

        {/* Input area */}
        <div
          className={cn(
            'bg-background shrink-0',
            inputExpanded
              ? 'fixed inset-4 z-50 rounded-xl shadow-2xl flex flex-col border border-border'
              : 'px-6 pb-4 pt-2',
          )}
        >
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Expanded mode header */}
          {inputExpanded && (
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-sm font-medium text-foreground">
                Compose Message
              </span>
              <button
                onClick={() => setInputExpanded(false)}
                className="p-1.5 rounded-md hover:bg-accent transition-colors"
                type="button"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
            className={cn('flex flex-col', inputExpanded ? 'flex-1 p-4' : '')}
          >
            <div
              className={cn(
                'rounded-xl border border-input bg-background relative',
                inputExpanded ? 'flex-1 flex flex-col' : '',
              )}
            >
              <div className={cn('relative', inputExpanded ? 'flex-1' : '')}>
                <textarea
                  ref={inputRef}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask Qwen Code..."
                  disabled={!isConnected}
                  rows={inputExpanded ? undefined : 4}
                  className={cn(
                    'w-full px-4 py-3 pr-12 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none text-sm rounded-xl resize-none',
                    inputExpanded ? 'h-full' : 'min-h-[120px] max-h-[300px]',
                  )}
                />
                <div className="absolute bottom-2 right-2">
                  {isStreaming ? (
                    <Button
                      type="button"
                      onClick={onCancel}
                      variant="destructive"
                      size="icon-sm"
                      className="rounded-lg"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      disabled={!inputText.trim() || !isConnected}
                      size="icon-sm"
                      className="rounded-lg bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setInputExpanded(!inputExpanded)}
                      className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-accent transition-colors"
                    >
                      {inputExpanded ? (
                        <X className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <Maximize2 className="h-5 w-5 text-muted-foreground" />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {inputExpanded ? 'Minimize' : 'Expand input'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="flex items-center justify-between mt-2 px-1">
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleFileSelect}
                      className="p-1.5 rounded-md hover:bg-accent transition-colors"
                    >
                      <Paperclip className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Attach files</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md cursor-default">
                      <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        {displayModel}
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Current model</TooltipContent>
                </Tooltip>

                {/* TODO: Enable when Coder Model supports thinking mode
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Thinking
                  </span>
                  <Switch
                    checked={thinkingEnabled}
                    onCheckedChange={setThinkingEnabled}
                  />
                </div>
                */}
              </div>

              <span className="text-xs text-muted-foreground">
                Press Enter to send, Shift+Enter for new line
              </span>
            </div>
          </form>
        </div>

        {/* Permission request modal */}
        {permissionRequest && (
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-popover rounded-xl p-6 max-w-md w-full mx-4 shadow-xl border border-border">
              <h3 className="text-lg font-semibold mb-3 text-foreground">
                Permission Request
              </h3>
              <p className="text-sm text-muted-foreground mb-5">
                {permissionRequest.description ||
                  `Allow ${permissionRequest.operation}?`}
              </p>
              <div className="flex gap-3 justify-end">
                <Button
                  onClick={() => onPermissionResponse('deny')}
                  variant="outline"
                >
                  Deny
                </Button>
                <Button
                  onClick={() => onPermissionResponse('allow_once')}
                  className="bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-600 hover:to-purple-700"
                >
                  Allow
                </Button>
              </div>
            </div>
          </div>
        )}
      </main>
    </TooltipProvider>
  );
}
