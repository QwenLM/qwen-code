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
} from './components/PermissionRequest.js';
import type { TextMessage } from './hooks/message/useMessageHandling.js';
import type { ToolCallData } from './components/ToolCall.js';
import { PermissionDrawer } from './components/PermissionDrawer.js';
import { ToolCall } from './components/ToolCall.js';
import { hasToolCallOutput } from './components/toolcalls/shared/utils.js';
// import { InProgressToolCall } from './components/InProgressToolCall.js';
import { EmptyState } from './components/ui/EmptyState.js';
import type { PlanEntry } from './components/PlanDisplay.js';
import { type CompletionItem } from './types/CompletionTypes.js';
import { useCompletionTrigger } from './hooks/useCompletionTrigger.js';
import { InfoBanner } from './components/ui/InfoBanner.js';
import { ChatHeader } from './components/ui/layouts/ChatHeader.js';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  WaitingMessage,
} from './components/messages/index.js';
import { InputForm } from './components/InputForm.js';
import { SessionSelector } from './components/session/SessionSelector.js';
import { FileIcon, UserIcon } from './components/icons/index.js';
import type { EditMode } from './types/toolCall.js';

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
  const [showBanner, setShowBanner] = useState(true);
  const [editMode, setEditMode] = useState<EditMode>('ask');
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [isComposing, setIsComposing] = useState(false);

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
  const handleSubmit = useMessageSubmit({
    inputText,
    setInputText,
    messageHandling,
    fileContext,
    vscode,
    inputFieldRef,
    isStreaming: messageHandling.isStreaming,
  });

  // Handle cancel streaming
  const handleCancel = useCallback(() => {
    if (messageHandling.isStreaming) {
      vscode.postMessage({
        type: 'cancelStreaming',
        data: {},
      });
    }
  }, [messageHandling.isStreaming, vscode]);

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

  // Handle toggle edit mode
  const handleToggleEditMode = useCallback(() => {
    setEditMode((prev) => {
      if (prev === 'ask') {
        return 'auto';
      }
      if (prev === 'auto') {
        return 'plan';
      }
      return 'ask';
    });
  }, []);

  // Handle toggle thinking
  const handleToggleThinking = () => {
    setThinkingEnabled((prev) => !prev);
  };

  const hasContent =
    messageHandling.messages.length > 0 ||
    messageHandling.isStreaming ||
    inProgressToolCalls.length > 0 ||
    completedToolCalls.length > 0 ||
    planEntries.length > 0;

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
      />

      <ChatHeader
        currentSessionTitle={sessionManagement.currentSessionTitle}
        onLoadSessions={sessionManagement.handleLoadQwenSessions}
        onNewSession={sessionManagement.handleNewQwenSession}
      />

      <div
        ref={messagesContainerRef}
        className="chat-messages flex-1 overflow-y-auto overflow-x-hidden pt-5 pr-5 pl-5 pb-[120px] flex flex-col relative min-w-0 focus:outline-none [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb:hover]:bg-white/30 [&>*]:flex [&>*]:gap-0 [&>*]:items-start [&>*]:text-left [&>*]:py-2 [&>*:not(:last-child)]:pb-[8px] [&>*]:flex-col [&>*]:relative [&>*]:animate-[fadeIn_0.2s_ease-in]"
        style={{ backgroundColor: 'var(--app-primary-background)' }}
      >
        {!hasContent ? (
          <EmptyState />
        ) : (
          <>
            {/* Create unified message array containing all types of messages and tool calls */}
            {(() => {
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
              const allMessages = [
                ...regularMessages,
                ...inProgressTools,
                ...completedTools,
              ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

              console.log('[App] allMessages:', allMessages);

              return allMessages.map((item, index) => {
                switch (item.type) {
                  case 'message': {
                    const msg = item.data as TextMessage;
                    const handleFileClick = (path: string) => {
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

                    return (
                      <AssistantMessage
                        key={`message-${index}`}
                        content={msg.content || ''}
                        timestamp={msg.timestamp || 0}
                        onFileClick={handleFileClick}
                      />
                    );
                  }

                  // case 'in-progress-tool-call':
                  //   return (
                  //     <InProgressToolCall
                  //       key={`in-progress-${(item.data as ToolCallData).toolCallId}`}
                  //       toolCall={item.data as ToolCallData}
                  //       // onFileClick={handleFileClick}
                  //     />
                  //   );

                  case 'in-progress-tool-call':
                  case 'completed-tool-call':
                    return (
                      <ToolCall
                        key={`completed-${(item.data as ToolCallData).toolCallId}`}
                        toolCall={item.data as ToolCallData}
                        // onFileClick={handleFileClick}
                      />
                    );

                  default:
                    return null;
                }
              });
            })()}

            {/* Changed to push each plan as a historical toolcall in useWebViewMessages to avoid duplicate display of the latest block */}

            {messageHandling.isWaitingForResponse &&
              messageHandling.loadingMessage && (
                <WaitingMessage
                  loadingMessage={messageHandling.loadingMessage}
                />
              )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <InfoBanner
        visible={showBanner}
        onDismiss={() => setShowBanner(false)}
        onLinkClick={(e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'openSettings', data: {} });
        }}
      />

      <InputForm
        inputText={inputText}
        inputFieldRef={inputFieldRef}
        isStreaming={messageHandling.isStreaming}
        isComposing={isComposing}
        editMode={editMode}
        thinkingEnabled={thinkingEnabled}
        activeFileName={fileContext.activeFileName}
        activeSelection={fileContext.activeSelection}
        onInputChange={setInputText}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={() => {}}
        onSubmit={handleSubmit.handleSubmit}
        onCancel={handleCancel}
        onToggleEditMode={handleToggleEditMode}
        onToggleThinking={handleToggleThinking}
        onFocusActiveEditor={fileContext.focusActiveEditor}
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

      {/* Claude-style dropdown is rendered inside InputForm for proper anchoring */}
    </div>
  );
};
