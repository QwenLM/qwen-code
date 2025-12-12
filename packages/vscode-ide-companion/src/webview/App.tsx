/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
} from 'react';
import { useVSCode } from './hooks/useVSCode.js';
import { useSessionManagement } from './hooks/session/useSessionManagement.js';
import { useFileContext } from './hooks/file/useFileContext.js';
import { useMessageHandling } from './hooks/message/useMessageHandling.js';
import { useToolCalls } from './hooks/useToolCalls.js';
import { useWebViewMessages } from './hooks/useWebViewMessages.js';
import { useMessageSubmit } from './hooks/useMessageSubmit.js';
import type {
  PermissionOption,
  ToolCall as PermissionToolCall,
} from './components/PermissionDrawer/PermissionRequest.js';
import type { TextMessage } from './hooks/message/useMessageHandling.js';
import type { ToolCallData } from './components/messages/toolcalls/ToolCall.js';
import { PermissionDrawer } from './components/PermissionDrawer/PermissionDrawer.js';
import { ToolCall } from './components/messages/toolcalls/ToolCall.js';
import { hasToolCallOutput } from './components/messages/toolcalls/shared/utils.js';
import { EmptyState } from './components/layout/EmptyState.js';
import { type CompletionItem } from '../types/completionItemTypes.js';
import { useCompletionTrigger } from './hooks/useCompletionTrigger.js';
import { ChatHeader } from './components/layout/ChatHeader.js';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  WaitingMessage,
  InterruptedMessage,
} from './components/messages/index.js';
import { InputForm } from './components/layout/InputForm.js';
import { SessionSelector } from './components/layout/SessionSelector.js';
import { FileIcon, UserIcon } from './components/icons/index.js';
import { ApprovalMode, NEXT_APPROVAL_MODE } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/acpTypes.js';
import type { PlanEntry } from '../types/chatTypes.js';

export const App: React.FC = () => {
  const vscode = useVSCode();

  // Core hooks
  const sessionManagement = useSessionManagement(vscode);
  const fileContext = useFileContext(vscode);
  const messageHandling = useMessageHandling();
  const {
    inProgressToolCalls,
    completedToolCalls,
    handleToolCallUpdate,
    clearToolCalls,
  } = useToolCalls();

  // UI state
  const [inputText, setInputText] = useState('');
  const [permissionRequest, setPermissionRequest] = useState<{
    options: PermissionOption[];
    toolCall: PermissionToolCall;
  } | null>(null);
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(
    null,
  ) as React.RefObject<HTMLDivElement>;
  // Scroll container for message list; used to keep the view anchored to the latest content
  const messagesContainerRef = useRef<HTMLDivElement>(
    null,
  ) as React.RefObject<HTMLDivElement>;
  const inputFieldRef = useRef<HTMLDivElement>(
    null,
  ) as React.RefObject<HTMLDivElement>;

  const [editMode, setEditMode] = useState<ApprovalModeValue>(
    ApprovalMode.DEFAULT,
  );
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  // When true, do NOT auto-attach the active editor file/selection to message context
  const [skipAutoActiveContext, setSkipAutoActiveContext] = useState(false);

  // Completion system
  const getCompletionItems = React.useCallback(
    async (trigger: '@' | '/', query: string): Promise<CompletionItem[]> => {
      if (trigger === '@') {
        if (!fileContext.hasRequestedFiles) {
          fileContext.requestWorkspaceFiles();
        }

        const fileIcon = <FileIcon />;
        const allItems: CompletionItem[] = fileContext.workspaceFiles.map(
          (file) => ({
            id: file.id,
            label: file.label,
            description: file.description,
            type: 'file' as const,
            icon: fileIcon,
            // Insert filename after @, keep path for mapping
            value: file.label,
            path: file.path,
          }),
        );

        if (query && query.length >= 1) {
          fileContext.requestWorkspaceFiles(query);
          const lowerQuery = query.toLowerCase();
          return allItems.filter(
            (item) =>
              item.label.toLowerCase().includes(lowerQuery) ||
              (item.description &&
                item.description.toLowerCase().includes(lowerQuery)),
          );
        }

        // If first time and still loading, show a placeholder
        if (allItems.length === 0) {
          return [
            {
              id: 'loading-files',
              label: 'Searching files…',
              description: 'Type to filter, or wait a moment…',
              type: 'info' as const,
            },
          ];
        }

        return allItems;
      } else {
        // Handle slash commands
        const commands: CompletionItem[] = [
          {
            id: 'login',
            label: '/login',
            description: 'Login to Qwen Code',
            type: 'command',
            icon: <UserIcon />,
          },
        ];

        return commands.filter((cmd) =>
          cmd.label.toLowerCase().includes(query.toLowerCase()),
        );
      }
    },
    [fileContext],
  );

  const completion = useCompletionTrigger(inputFieldRef, getCompletionItems);

  // When workspace files update while menu open for @, refresh items so the first @ shows the list
  // Note: Avoid depending on the entire `completion` object here, since its identity
  // changes on every render which would retrigger this effect and can cause a refresh loop.
  useEffect(() => {
    if (completion.isOpen && completion.triggerChar === '@') {
      // Only refresh items; do not change other completion state to avoid re-renders loops
      completion.refreshCompletion();
    }
    // Only re-run when the actual data source changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileContext.workspaceFiles, completion.isOpen, completion.triggerChar]);

  // Message submission
  const { handleSubmit: submitMessage } = useMessageSubmit({
    inputText,
    setInputText,
    messageHandling,
    fileContext,
    skipAutoActiveContext,
    vscode,
    inputFieldRef,
    isStreaming: messageHandling.isStreaming,
  });

  // Handle cancel/stop from the input bar
  // Emit a cancel to the extension and immediately reflect interruption locally.
  const handleCancel = useCallback(() => {
    if (messageHandling.isStreaming || messageHandling.isWaitingForResponse) {
      // Proactively end local states and add an 'Interrupted' line
      try {
        messageHandling.endStreaming?.();
      } catch {
        /* no-op */
      }
      try {
        messageHandling.clearWaitingForResponse?.();
      } catch {
        /* no-op */
      }
      messageHandling.addMessage({
        role: 'assistant',
        content: 'Interrupted',
        timestamp: Date.now(),
      });
    }
    // Notify extension/agent to cancel server-side work
    vscode.postMessage({
      type: 'cancelStreaming',
      data: {},
    });
  }, [messageHandling, vscode]);

  // Message handling
  useWebViewMessages({
    sessionManagement,
    fileContext,
    messageHandling,
    handleToolCallUpdate,
    clearToolCalls,
    setPlanEntries,
    handlePermissionRequest: setPermissionRequest,
    inputFieldRef,
    setInputText,
    setEditMode,
  });

  // Auto-scroll handling: keep the view pinned to bottom when new content arrives,
  // but don't interrupt the user if they scrolled up.
  // We track whether the user is currently "pinned" to the bottom (near the end).
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const prevCountsRef = useRef({ msgLen: 0, inProgLen: 0, doneLen: 0 });

  // Observe scroll position to know if user has scrolled away from the bottom.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    const onScroll = () => {
      // Use a small threshold so slight deltas don't flip the state.
      // Note: there's extra bottom padding for the input area, so keep this a bit generous.
      const threshold = 80; // px tolerance
      const distanceFromBottom =
        container.scrollHeight - (container.scrollTop + container.clientHeight);
      setPinnedToBottom(distanceFromBottom <= threshold);
    };

    // Initialize once mounted so first render is correct
    onScroll();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  // When content changes, if the user is pinned to bottom, keep it anchored there.
  // Only smooth-scroll when new items are appended; do not smooth for streaming chunk updates.
  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }

    // Detect whether new items were appended (vs. streaming chunk updates)
    const prev = prevCountsRef.current;
    const newMsg = messageHandling.messages.length > prev.msgLen;
    const newInProg = inProgressToolCalls.length > prev.inProgLen;
    const newDone = completedToolCalls.length > prev.doneLen;
    prevCountsRef.current = {
      msgLen: messageHandling.messages.length,
      inProgLen: inProgressToolCalls.length,
      doneLen: completedToolCalls.length,
    };

    if (!pinnedToBottom) {
      // Do nothing if user scrolled away; avoid stealing scroll.
      return;
    }

    const smooth = newMsg || newInProg || newDone; // avoid smooth on streaming chunks

    // Anchor to the bottom on next frame to avoid layout thrash.
    const raf = requestAnimationFrame(() => {
      const top = container.scrollHeight - container.clientHeight;
      // Use scrollTo to avoid cross-context issues with scrollIntoView.
      container.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    });
    return () => cancelAnimationFrame(raf);
  }, [
    pinnedToBottom,
    messageHandling.messages,
    inProgressToolCalls,
    completedToolCalls,
    messageHandling.isWaitingForResponse,
    messageHandling.loadingMessage,
    messageHandling.isStreaming,
    planEntries,
  ]);

  // When the last rendered item resizes (e.g., images/code blocks load/expand),
  // if we're pinned to bottom, keep it anchored there.
  useEffect(() => {
    const container = messagesContainerRef.current;
    const endEl = messagesEndRef.current;
    if (!container || !endEl) {
      return;
    }

    const lastItem = endEl.previousElementSibling as HTMLElement | null;
    if (!lastItem) {
      return;
    }

    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (!pinnedToBottom) {
        return;
      }
      // Defer to next frame to avoid thrash during rapid size changes
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top });
      });
    });
    ro.observe(lastItem);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [
    pinnedToBottom,
    messageHandling.messages,
    inProgressToolCalls,
    completedToolCalls,
  ]);

  // Handle permission response
  const handlePermissionResponse = useCallback(
    (optionId: string) => {
      // Forward the selected optionId directly to extension as ACP permission response
      // Expected values include: 'proceed_once', 'proceed_always', 'cancel', 'proceed_always_server', etc.
      vscode.postMessage({
        type: 'permissionResponse',
        data: { optionId },
      });
      setPermissionRequest(null);
    },
    [vscode],
  );

  // Handle completion selection
  const handleCompletionSelect = useCallback(
    (item: CompletionItem) => {
      // Handle completion selection by inserting the value into the input field
      const inputElement = inputFieldRef.current;
      if (!inputElement) {
        return;
      }

      // Ignore info items (placeholders like "Searching files…")
      if (item.type === 'info') {
        completion.closeCompletion();
        return;
      }

      // Slash commands can execute immediately
      if (item.type === 'command') {
        const command = (item.label || '').trim();
        if (command === '/login') {
          vscode.postMessage({ type: 'login', data: {} });
          completion.closeCompletion();
          return;
        }
      }

      // If selecting a file, add @filename -> fullpath mapping
      if (item.type === 'file' && item.value && item.path) {
        try {
          fileContext.addFileReference(item.value, item.path);
        } catch (err) {
          console.warn('[App] addFileReference failed:', err);
        }
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }

      // Current text and cursor
      const text = inputElement.textContent || '';
      const range = selection.getRangeAt(0);

      // Compute total text offset for contentEditable
      let cursorPos = text.length;
      if (range.startContainer === inputElement) {
        const childIndex = range.startOffset;
        let offset = 0;
        for (
          let i = 0;
          i < childIndex && i < inputElement.childNodes.length;
          i++
        ) {
          offset += inputElement.childNodes[i].textContent?.length || 0;
        }
        cursorPos = offset || text.length;
      } else if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const walker = document.createTreeWalker(
          inputElement,
          NodeFilter.SHOW_TEXT,
          null,
        );
        let offset = 0;
        let found = false;
        let node: Node | null = walker.nextNode();
        while (node) {
          if (node === range.startContainer) {
            offset += range.startOffset;
            found = true;
            break;
          }
          offset += node.textContent?.length || 0;
          node = walker.nextNode();
        }
        cursorPos = found ? offset : text.length;
      }

      // Replace from trigger to cursor with selected value
      const textBeforeCursor = text.substring(0, cursorPos);
      const atPos = textBeforeCursor.lastIndexOf('@');
      const slashPos = textBeforeCursor.lastIndexOf('/');
      const triggerPos = Math.max(atPos, slashPos);

      if (triggerPos >= 0) {
        const insertValue =
          typeof item.value === 'string' ? item.value : String(item.label);
        const newText =
          text.substring(0, triggerPos + 1) + // keep the trigger symbol
          insertValue +
          ' ' +
          text.substring(cursorPos);

        // Update DOM and state, and move caret to end
        inputElement.textContent = newText;
        setInputText(newText);

        const newRange = document.createRange();
        const sel = window.getSelection();
        newRange.selectNodeContents(inputElement);
        newRange.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(newRange);
      }

      // Close the completion menu
      completion.closeCompletion();
    },
    [completion, inputFieldRef, setInputText, fileContext, vscode],
  );

  // Handle attach context click
  const handleAttachContextClick = useCallback(() => {
    // Open native file picker (different from '@' completion which searches workspace files)
    vscode.postMessage({
      type: 'attachFile',
      data: {},
    });
  }, [vscode]);

  // Handle toggle edit mode (Default -> Auto-edit -> YOLO -> Default)
  const handleToggleEditMode = useCallback(() => {
    setEditMode((prev) => {
      const next: ApprovalModeValue = NEXT_APPROVAL_MODE[prev];

      // Notify extension to set approval mode via ACP
      try {
        vscode.postMessage({
          type: 'setApprovalMode',
          data: { modeId: next },
        });
      } catch {
        /* no-op */
      }
      return next;
    });
  }, [vscode]);

  // Handle toggle thinking
  const handleToggleThinking = () => {
    setThinkingEnabled((prev) => !prev);
  };

  // When user sends a message after scrolling up, re-pin and jump to the bottom
  const handleSubmitWithScroll = useCallback(
    (e: React.FormEvent) => {
      setPinnedToBottom(true);

      const container = messagesContainerRef.current;
      if (container) {
        const top = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top });
      }

      submitMessage(e);
    },
    [submitMessage],
  );

  // Create unified message array containing all types of messages and tool calls
  const allMessages = useMemo<
    Array<{
      type: 'message' | 'in-progress-tool-call' | 'completed-tool-call';
      data: TextMessage | ToolCallData;
      timestamp: number;
    }>
  >(() => {
    // Regular messages
    const regularMessages = messageHandling.messages.map((msg) => ({
      type: 'message' as const,
      data: msg,
      timestamp: msg.timestamp,
    }));

    // In-progress tool calls
    const inProgressTools = inProgressToolCalls.map((toolCall) => ({
      type: 'in-progress-tool-call' as const,
      data: toolCall,
      timestamp: toolCall.timestamp || Date.now(),
    }));

    // Completed tool calls
    const completedTools = completedToolCalls
      .filter(hasToolCallOutput)
      .map((toolCall) => ({
        type: 'completed-tool-call' as const,
        data: toolCall,
        timestamp: toolCall.timestamp || Date.now(),
      }));

    // Merge and sort by timestamp to ensure messages and tool calls are interleaved
    return [...regularMessages, ...inProgressTools, ...completedTools].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );
  }, [messageHandling.messages, inProgressToolCalls, completedToolCalls]);

  console.log('[App] Rendering messages:', allMessages);

  // Render all messages and tool calls
  const renderMessages = useCallback<() => React.ReactNode>(
    () =>
      allMessages.map((item, index) => {
        switch (item.type) {
          case 'message': {
            const msg = item.data as TextMessage;
            const handleFileClick = (path: string): void => {
              vscode.postMessage({
                type: 'openFile',
                data: { path },
              });
            };

            if (msg.role === 'thinking') {
              return (
                <ThinkingMessage
                  key={`message-${index}`}
                  content={msg.content || ''}
                  timestamp={msg.timestamp || 0}
                  onFileClick={handleFileClick}
                />
              );
            }

            if (msg.role === 'user') {
              return (
                <UserMessage
                  key={`message-${index}`}
                  content={msg.content || ''}
                  timestamp={msg.timestamp || 0}
                  onFileClick={handleFileClick}
                  fileContext={msg.fileContext}
                />
              );
            }

            {
              const content = (msg.content || '').trim();
              if (content === 'Interrupted' || content === 'Tool interrupted') {
                return (
                  <InterruptedMessage key={`message-${index}`} text={content} />
                );
              }
              return (
                <AssistantMessage
                  key={`message-${index}`}
                  content={content}
                  timestamp={msg.timestamp || 0}
                  onFileClick={handleFileClick}
                />
              );
            }
          }

          case 'in-progress-tool-call':
          case 'completed-tool-call': {
            const prev = allMessages[index - 1];
            const next = allMessages[index + 1];
            const isToolCallType = (
              x: unknown,
            ): x is { type: 'in-progress-tool-call' | 'completed-tool-call' } =>
              !!x &&
              typeof x === 'object' &&
              'type' in (x as Record<string, unknown>) &&
              ((x as { type: string }).type === 'in-progress-tool-call' ||
                (x as { type: string }).type === 'completed-tool-call');
            const isFirst = !isToolCallType(prev);
            const isLast = !isToolCallType(next);
            return (
              <ToolCall
                key={`toolcall-${(item.data as ToolCallData).toolCallId}-${item.type}`}
                toolCall={item.data as ToolCallData}
                isFirst={isFirst}
                isLast={isLast}
              />
            );
          }

          default:
            return null;
        }
      }),
    [allMessages, vscode],
  );

  const hasContent =
    messageHandling.messages.length > 0 ||
    messageHandling.isStreaming ||
    inProgressToolCalls.length > 0 ||
    completedToolCalls.length > 0 ||
    planEntries.length > 0 ||
    allMessages.length > 0;

  return (
    <div className="chat-container">
      <SessionSelector
        visible={sessionManagement.showSessionSelector}
        sessions={sessionManagement.filteredSessions}
        currentSessionId={sessionManagement.currentSessionId}
        searchQuery={sessionManagement.sessionSearchQuery}
        onSearchChange={sessionManagement.setSessionSearchQuery}
        onSelectSession={(sessionId) => {
          sessionManagement.handleSwitchSession(sessionId);
          sessionManagement.setSessionSearchQuery('');
        }}
        onClose={() => sessionManagement.setShowSessionSelector(false)}
        hasMore={sessionManagement.hasMore}
        isLoading={sessionManagement.isLoading}
        onLoadMore={sessionManagement.handleLoadMoreSessions}
      />

      <ChatHeader
        currentSessionTitle={sessionManagement.currentSessionTitle}
        onLoadSessions={sessionManagement.handleLoadQwenSessions}
        onNewSession={sessionManagement.handleNewQwenSession}
      />

      <div
        ref={messagesContainerRef}
        className="chat-messages messages-container flex-1 overflow-y-auto overflow-x-hidden pt-5 pr-5 pl-5 pb-[120px] flex flex-col relative min-w-0 focus:outline-none [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:hover:bg-white/30 [&>*]:flex [&>*]:gap-0 [&>*]:items-start [&>*]:text-left [&>*]:py-2 [&>*:not(:last-child)]:pb-[8px] [&>*]:flex-col [&>*]:relative [&>*]:animate-[fadeIn_0.2s_ease-in]"
      >
        {!hasContent ? (
          <EmptyState />
        ) : (
          <>
            {/* Render all messages and tool calls */}
            {renderMessages()}
            {/* Flow-in persistent slot: keeps a small constant height so toggling */}
            {/* the waiting message doesn't change list height to zero. When */}
            {/* active, render the waiting message inline (not fixed). */}
            <div className="waiting-message-slot min-h-[28px]">
              {messageHandling.isWaitingForResponse &&
                messageHandling.loadingMessage && (
                  <WaitingMessage
                    loadingMessage={messageHandling.loadingMessage}
                  />
                )}
            </div>

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <InputForm
        inputText={inputText}
        inputFieldRef={inputFieldRef}
        isStreaming={messageHandling.isStreaming}
        isWaitingForResponse={messageHandling.isWaitingForResponse}
        isComposing={isComposing}
        editMode={editMode}
        thinkingEnabled={thinkingEnabled}
        activeFileName={fileContext.activeFileName}
        activeSelection={fileContext.activeSelection}
        skipAutoActiveContext={skipAutoActiveContext}
        onInputChange={setInputText}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={() => {}}
        onSubmit={handleSubmitWithScroll}
        onCancel={handleCancel}
        onToggleEditMode={handleToggleEditMode}
        onToggleThinking={handleToggleThinking}
        onFocusActiveEditor={fileContext.focusActiveEditor}
        onToggleSkipAutoActiveContext={() =>
          setSkipAutoActiveContext((v) => !v)
        }
        onShowCommandMenu={async () => {
          if (inputFieldRef.current) {
            inputFieldRef.current.focus();

            const selection = window.getSelection();
            let position = { top: 0, left: 0 };

            if (selection && selection.rangeCount > 0) {
              try {
                const range = selection.getRangeAt(0);
                const rangeRect = range.getBoundingClientRect();
                if (rangeRect.top > 0 && rangeRect.left > 0) {
                  position = {
                    top: rangeRect.top,
                    left: rangeRect.left,
                  };
                } else {
                  const inputRect =
                    inputFieldRef.current.getBoundingClientRect();
                  position = { top: inputRect.top, left: inputRect.left };
                }
              } catch (error) {
                console.error('[App] Error getting cursor position:', error);
                const inputRect = inputFieldRef.current.getBoundingClientRect();
                position = { top: inputRect.top, left: inputRect.left };
              }
            } else {
              const inputRect = inputFieldRef.current.getBoundingClientRect();
              position = { top: inputRect.top, left: inputRect.left };
            }

            await completion.openCompletion('/', '', position);
          }
        }}
        onAttachContext={handleAttachContextClick}
        completionIsOpen={completion.isOpen}
        completionItems={completion.items}
        onCompletionSelect={handleCompletionSelect}
        onCompletionClose={completion.closeCompletion}
      />

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
