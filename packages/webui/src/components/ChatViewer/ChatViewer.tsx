/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { UserMessage } from '../messages/UserMessage.js';
import { AssistantMessage } from '../messages/Assistant/AssistantMessage.js';
import { ThinkingMessage } from '../messages/ThinkingMessage.js';
import {
  shouldShowToolCall,
  getToolCallComponent,
} from '../toolcalls/index.js';
import type { ToolCallData as BaseToolCallData } from '../toolcalls/index.js';
import { getUserTranscriptDisplayText } from '../../adapters/userTranscriptDisplay.js';
import {
  ExpandControlContext,
  type ExpandControlContextValue,
} from '../../context/ExpandControlContext.js';
import './ChatViewer.css';

/**
 * Message part containing text content (Qwen format)
 */
export interface MessagePart {
  text: string;
}

/**
 * Claude format content item
 */
export interface ClaudeContentItem {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: unknown;
}

/**
 * Tool call data for rendering tool call UI
 */
export type ToolCallData = BaseToolCallData;

/**
 * Single chat message from JSONL format
 * Supports both Qwen format and Claude format
 */
export interface ChatMessageData {
  uuid: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp: string; // ISO timestamp string
  type: 'user' | 'assistant' | 'system' | 'tool_call';
  // Qwen format
  message?: {
    role?: string;
    parts?: MessagePart[];
    content?: string | ClaudeContentItem[]; // Claude format content
  };
  model?: string; // for assistant messages
  // Tool call data
  toolCall?: ToolCallData;
  systemPayload?: unknown;
  // Additional Claude format fields
  cwd?: string;
  gitBranch?: string;
}

/**
 * ChatViewer ref handle for programmatic control
 */
export interface ChatViewerHandle {
  /** Scroll to the bottom of the messages */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Scroll to the top of the messages */
  scrollToTop: (behavior?: ScrollBehavior) => void;
  /** Get the scroll container element */
  getScrollContainer: () => HTMLDivElement | null;
}

/**
 * ChatViewer component props
 */
export interface ChatViewerProps {
  /** Array of chat messages in JSONL format */
  messages: ChatMessageData[];
  /** Optional additional CSS class name */
  className?: string;
  /** Optional callback when a file path is clicked */
  onFileClick?: (path: string) => void;
  /** Optional empty state message */
  emptyMessage?: string;
  /** Whether to auto-scroll to bottom when new messages arrive (default: true) */
  autoScroll?: boolean;
  /** Theme variant: 'dark' | 'light' | 'auto' (default: 'auto') */
  theme?: 'dark' | 'light' | 'auto';
  /** Show empty state icon (default: true) */
  showEmptyIcon?: boolean;
  /**
   * Show a global "Expand all / Collapse all" control above the messages
   * (default: false). When enabled, the control broadcasts expand/collapse
   * signals to every collapsible section (thinking blocks, tool outputs,
   * file references) via {@link ExpandControlContext}; individual toggles
   * keep working between global commands.
   */
  showExpandControl?: boolean;
}

/**
 * Extract text content from message (supports both Qwen and Claude formats)
 */
function extractContent(message: ChatMessageData['message']): string {
  if (!message) return '';

  // Qwen format: message.parts[].text
  if (message.parts && Array.isArray(message.parts)) {
    return message.parts.map((part) => part.text || '').join('');
  }

  // Claude format: message.content as string
  if (typeof message.content === 'string') {
    return message.content;
  }

  // Claude format: message.content as array of content items
  if (Array.isArray(message.content)) {
    return message.content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text || '')
      .join('');
  }

  return '';
}

/**
 * Convert ISO timestamp string to numeric timestamp
 */
function parseTimestamp(isoString: string): number {
  const date = new Date(isoString);
  return isNaN(date.getTime()) ? Date.now() : date.getTime();
}

/**
 * ChatViewer - A standalone component for displaying chat conversations
 *
 * Renders a conversation flow from JSONL-formatted data using existing
 * message components (UserMessage, AssistantMessage, ThinkingMessage).
 * This is a pure UI component without VSCode or external dependencies.
 *
 * @example
 * ```tsx
 * const messages = [
 *   { uuid: '1', type: 'user', message: { role: 'user', parts: [{ text: 'Hello!' }] }, ... },
 *   { uuid: '2', type: 'assistant', message: { role: 'model', parts: [{ text: 'Hi there!' }] }, ... },
 * ];
 *
 * <ChatViewer messages={messages} onFileClick={(path) => console.log(path)} />
 * ```
 *
 * @example With ref for programmatic control
 * ```tsx
 * const chatRef = useRef<ChatViewerHandle>(null);
 *
 * // Scroll to bottom programmatically
 * chatRef.current?.scrollToBottom('smooth');
 *
 * <ChatViewer ref={chatRef} messages={messages} />
 * ```
 */
export const ChatViewer = forwardRef<ChatViewerHandle, ChatViewerProps>(
  (
    {
      messages,
      className = '',
      onFileClick,
      emptyMessage = 'No messages to display',
      autoScroll = true,
      theme = 'auto',
      showEmptyIcon = true,
      showExpandControl = false,
    },
    ref,
  ) => {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const scrollAnchorRef = useRef<HTMLDivElement>(null);
    const prevMessageCountRef = useRef(0);

    // Global expand/collapse state broadcast to collapsible sections.
    // `signal` is bumped on every command so consumers can distinguish a
    // fresh global command from ordinary re-renders.
    const [expandControl, setExpandControl] =
      useState<ExpandControlContextValue>({ signal: 0, expanded: false });

    const issueExpandControl = (expanded: boolean) => {
      setExpandControl((current) => ({
        signal: current.signal + 1,
        expanded,
      }));
    };

    // Sort messages by timestamp and filter out system messages and hidden tool calls
    const sortedMessages = useMemo(
      () =>
        messages
          .filter((msg) => {
            if (msg.type === 'system') return false;
            // Filter out hidden tool calls
            if (msg.type === 'tool_call' && msg.toolCall) {
              return shouldShowToolCall(msg.toolCall.kind);
            }
            return true;
          })
          .sort(
            (a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp),
          ),
      [messages],
    );

    // Expose imperative handle for programmatic control
    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: (behavior: ScrollBehavior = 'smooth') => {
          const container = scrollContainerRef.current;
          if (container) {
            container.scrollTo({
              top: container.scrollHeight,
              behavior,
            });
          }
        },
        scrollToTop: (behavior: ScrollBehavior = 'smooth') => {
          const container = scrollContainerRef.current;
          if (container) {
            container.scrollTo({
              top: 0,
              behavior,
            });
          }
        },
        getScrollContainer: () => scrollContainerRef.current,
      }),
      [],
    );

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
      if (!autoScroll) return;

      const currentCount = sortedMessages.length;
      const prevCount = prevMessageCountRef.current;

      // Only auto-scroll when new messages are added
      if (currentCount > prevCount && scrollAnchorRef.current) {
        scrollAnchorRef.current.scrollIntoView({ behavior: 'smooth' });
      }

      prevMessageCountRef.current = currentCount;
    }, [sortedMessages.length, autoScroll]);

    // Determine if previous/next is a user message (breaks the AI sequence)
    const isUserType = (msg: ChatMessageData | undefined) =>
      !msg || msg.type === 'user';

    // Render individual message based on type
    const renderMessage = (
      msg: ChatMessageData,
      index: number,
      allMsgs: ChatMessageData[],
    ) => {
      const key = msg.uuid || `msg-${index}`;
      const prev = allMsgs[index - 1];
      const next = allMsgs[index + 1];

      // Calculate timeline position for AI responses
      const isFirst = isUserType(prev);
      const isLast = isUserType(next);

      // Handle tool calls
      if (msg.type === 'tool_call' && msg.toolCall) {
        const ToolCallComponent = getToolCallComponent(msg.toolCall);

        if (!ToolCallComponent) {
          return null;
        }

        return (
          <ToolCallComponent
            key={key}
            toolCall={msg.toolCall}
            isFirst={isFirst}
            isLast={isLast}
          />
        );
      }

      const content =
        getUserTranscriptDisplayText(msg) ?? extractContent(msg.message);
      const timestamp = parseTimestamp(msg.timestamp);

      // Skip empty messages (but not tool calls)
      if (!content.trim()) {
        return null;
      }

      switch (msg.type) {
        case 'user':
          return (
            <UserMessage
              key={key}
              content={content}
              timestamp={timestamp}
              onFileClick={onFileClick}
            />
          );

        case 'assistant':
          // Check if this is a thinking message based on role
          if (msg.message?.role === 'thinking') {
            return (
              <ThinkingMessage
                key={key}
                content={content}
                timestamp={timestamp}
                onFileClick={onFileClick}
              />
            );
          }
          return (
            <AssistantMessage
              key={key}
              content={content}
              timestamp={timestamp}
              onFileClick={onFileClick}
              isFirst={isFirst}
              isLast={isLast}
            />
          );

        default:
          return null;
      }
    };

    // Build container class names
    const containerClasses = [
      'chat-viewer-container',
      theme === 'light' ? 'light-theme' : '',
      theme === 'auto' ? 'auto-theme' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const showExpandToolbar = showExpandControl && sortedMessages.length > 0;

    const messagesRegion = (
      <div
        ref={scrollContainerRef}
        className="chat-viewer-messages chat-messages"
      >
        {sortedMessages.length === 0 ? (
          <div className="chat-viewer-empty">
            {showEmptyIcon && (
              <div className="chat-viewer-empty-icon" aria-hidden="true">
                💬
              </div>
            )}
            <div className="chat-viewer-empty-text">{emptyMessage}</div>
          </div>
        ) : (
          <>
            {sortedMessages.map((msg, index) =>
              renderMessage(msg, index, sortedMessages),
            )}
            {/* Scroll anchor for auto-scroll functionality */}
            <div ref={scrollAnchorRef} className="chat-viewer-scroll-anchor" />
          </>
        )}
      </div>
    );

    return (
      <div className={containerClasses}>
        {showExpandToolbar && (
          <div
            className="chat-viewer-expand-control"
            role="toolbar"
            aria-label="Expand or collapse all sections"
          >
            <button
              type="button"
              className="chat-viewer-expand-control-button"
              aria-label="Expand all sections"
              onClick={() => issueExpandControl(true)}
            >
              Expand all
            </button>
            <button
              type="button"
              className="chat-viewer-expand-control-button"
              aria-label="Collapse all sections"
              onClick={() => issueExpandControl(false)}
            >
              Collapse all
            </button>
          </div>
        )}
        {showExpandControl ? (
          <ExpandControlContext.Provider value={expandControl}>
            {messagesRegion}
          </ExpandControlContext.Provider>
        ) : (
          messagesRegion
        )}
      </div>
    );
  },
);

ChatViewer.displayName = 'ChatViewer';

export default ChatViewer;
