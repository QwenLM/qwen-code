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
import {
  shouldSendMessage,
  useMessageSubmit,
} from './hooks/useMessageSubmit.js';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
import type { TextMessage } from './hooks/message/useMessageHandling.js';
import type { ToolCallData } from './components/messages/toolcalls/ToolCall.js';
import { ToolCall } from './components/messages/toolcalls/ToolCall.js';
import { hasToolCallOutput } from './utils/utils.js';
import { Onboarding } from './components/layout/Onboarding.js';
import { type CompletionItem } from '../types/completionItemTypes.js';
import { useCompletionTrigger } from './hooks/useCompletionTrigger.js';
import {
  AssistantMessage,
  UserMessage,
  ThinkingMessage,
  WaitingMessage,
  InterruptedMessage,
  FileIcon,
  PermissionDrawer,
  AskUserQuestionDialog,
  ImageMessageRenderer,
  ImagePreview,
  // Layout components imported directly from webui
  EmptyState,
  ChatHeader,
  SessionSelector,
} from '@qwen-code/webui';
import { InputForm } from './components/layout/InputForm.js';
import { ApprovalMode, NEXT_APPROVAL_MODE } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type { PlanEntry, UsageStatsPayload } from '../types/chatTypes.js';
import type { ModelInfo, AvailableCommand } from '@agentclientprotocol/sdk';
import type { Question } from '../types/acpTypes.js';
import { useImagePaste, type WebViewImageMessage } from './hooks/useImage.js';
import { computeContextUsage } from './utils/contextUsage.js';
import { mergeLocalAvailableCommands } from './utils/localSlashCommands.js';

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
  const [askUserQuestionRequest, setAskUserQuestionRequest] = useState<{
    questions: Question[];
    sessionId: string;
    metadata?: {
      source?: string;
    };
  } | null>(null);
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true); // Track if we're still initializing/loading
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStatsPayload | null>(null);
  const [availableCommands, setAvailableCommands] = useState<
    AvailableCommand[]
  >([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Scroll container for message list; used to keep the view anchored to the latest content
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const inputFieldRef = useRef<HTMLDivElement | null>(null);

  const [editMode, setEditMode] = useState<ApprovalModeValue>(
    ApprovalMode.DEFAULT,
  );
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  // When true, do NOT auto-attach the active editor file/selection to message context
  const [skipAutoActiveContext, setSkipAutoActiveContext] = useState(false);
  const slashCommands = useMemo(
    () => mergeLocalAvailableCommands(availableCommands),
    [availableCommands],
  );

  // Completion system
  const getCompletionItems = React.useCallback(
    async (trigger: '@' | '/', query: string): Promise<CompletionItem[]> => {
      if (trigger === '@') {
        console.log('[App] getCompletionItems @ called', {
          query,
          requested: fileContext.hasRequestedFiles,
          workspaceFiles: fileContext.workspaceFiles.length,
        });
        // Always trigger request based on current query, let the hook decide if an actual request is needed
        fileContext.requestWorkspaceFiles(query);

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

        // Fuzzy search is handled by the backend (FileSearchFactory)
        // No client-side filtering needed - results are already fuzzy-matched

        // If first time and still loading, show a placeholder
        if (allItems.length === 0 && query && query.length >= 1) {
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
        // Handle slash commands with grouping
        // Model group - special items without / prefix
        const modelGroupItems: CompletionItem[] = [
          {
            id: 'model',
            label: 'Switch model...',
            description: modelInfo?.name || 'Default',
            type: 'command',
            group: 'Model',
          },
        ];

        // Account group
        const accountGroupItems: CompletionItem[] = [
          {
            id: 'login',
            label: 'Login',
            description: 'Login to Qwen Code',
            type: 'command',
            group: 'Account',
          },
        ];

        // Slash Commands group - ACP commands plus local companion-only commands
        const slashCommandItems: CompletionItem[] = slashCommands.map(
          (cmd) => ({
            id: cmd.name,
            label: `/${cmd.name}`,
            description: cmd.description,
            type: 'command' as const,
            group: 'Slash Commands',
            value: cmd.name,
          }),
        );

        // Combine all commands
        const allCommands = [
          ...modelGroupItems,
          ...accountGroupItems,
          ...slashCommandItems,
        ];

        // Filter by query
        const lowerQuery = query.toLowerCase();
        return allCommands.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(lowerQuery) ||
            (cmd.description &&
              cmd.description.toLowerCase().includes(lowerQuery)),
        );
      }
    },
    [fileContext, modelInfo?.name, slashCommands],
  );

  const completion = useCompletionTrigger(inputFieldRef, getCompletionItems);

  const contextUsage = useMemo(
    () => computeContextUsage(usageStats, modelInfo),
    [usageStats, modelInfo],
  );

  // Track a lightweight signature of workspace files to detect content changes even when length is unchanged
  const workspaceFilesSignature = useMemo(
    () =>
      fileContext.workspaceFiles
        .map(
          (file) =>
            `${file.id}|${file.label}|${file.description ?? ''}|${file.path}`,
        )
        .join('||'),
    [fileContext.workspaceFiles],
  );

  // When workspace files update while menu open for @, refresh items to reflect latest search results.
  // Note: Avoid depending on the entire `completion` object here, since its identity
  // changes on every render which would retrigger this effect and can cause a refresh loop.
  useEffect(() => {
    if (completion.isOpen && completion.triggerChar === '@') {
      // Only refresh items; do not change other completion state to avoid re-renders loops
      completion.refreshCompletion();
    }
    // Only re-run when the actual data source changes, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceFilesSignature,
    completion.isOpen,
    completion.triggerChar,
    completion.query,
  ]);

  const { attachedImages, handleRemoveImage, clearImages, handlePaste } =
    useImagePaste({
      onError: (error) => {
        console.error('Paste error:', error);
      },
    });

  const { handleSubmit: submitMessage } = useMessageSubmit({
    inputText,
    setInputText,
    attachedImages,
    clearImages,
    messageHandling,
    fileContext,
    skipAutoActiveContext,
    vscode,
    inputFieldRef,
    isStreaming: messageHandling.isStreaming,
    isWaitingForResponse: messageHandling.isWaitingForResponse,
  });

  const canSubmit = shouldSendMessage({
    inputText,
    attachedImages,
    isStreaming: messageHandling.isStreaming,
    isWaitingForResponse: messageHandling.isWaitingForResponse,
  });

  // Handle cancel/stop from the input bar
  // Emit a cancel to the extension and immediately reflect interruption locally.
  const handleCancel = useCallback(() => {
    if (messageHandling.isStreaming || messageHandling.isWaitingForResponse) {
      // End streaming state and add an 'Interrupted' line.
      // IMPORTANT: Do NOT clear isWaitingForResponse here — let the
      // extension's streamEnd message clear it after the cancel is
      // properly processed on the backend.  This keeps the submit
      // guard active and prevents any cached input from being
      // auto-submitted during the cancel → confirmed window.
      if (messageHandling.isStreaming) {
        try {
          messageHandling.endStreaming?.();
        } catch {
          /* no-op */
        }
        messageHandling.addMessage({
          role: 'assistant',
          content: 'Interrupted',
          timestamp: Date.now(),
        });
      }
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
    handleAskUserQuestion: setAskUserQuestionRequest,
    inputFieldRef,
    setInputText,
    setEditMode,
    setIsAuthenticated,
    setUsageStats: (stats) => setUsageStats(stats ?? null),
    setModelInfo: (info) => {
      setModelInfo(info);
    },
    setAvailableCommands: (commands) => {
      setAvailableCommands(commands);
    },
    setAvailableModels: (models) => {
      setAvailableModels(models);
    },
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

  // Set loading state to false after initial mount and when we have authentication info
  useEffect(() => {
    if (isAuthenticated !== null) {
      setIsLoading(false);
      return;
    }

    // Safety-net timeout: if initialization takes too long (e.g. CLI crashed
    // before the error could be surfaced), stop the spinner and let the user
    // see the onboarding / error UI instead of hanging forever.
    const timeout = setTimeout(() => {
      setIsLoading(false);
    }, 30_000);
    return () => clearTimeout(timeout);
  }, [isAuthenticated]);

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

  // Handle ask user question response
  const handleAskUserQuestionResponse = useCallback(
    (answers: Record<string, string>) => {
      // Forward answers to extension as ACP permission response
      vscode.postMessage({
        type: 'askUserQuestionResponse',
        data: { answers },
      });

      setAskUserQuestionRequest(null);
    },
    [vscode],
  );

  // Handle ask user question cancel
  const handleAskUserQuestionCancel = useCallback(() => {
    // Forward cancel to extension as ACP permission response with cancel option
    vscode.postMessage({
      type: 'askUserQuestionResponse',
      data: { answers: {}, cancelled: true },
    });

    setAskUserQuestionRequest(null);
  }, [vscode]);

  // Handle completion selection.
  // When fillOnly is true (Tab), slash commands are inserted into the input
  // instead of being sent immediately, so users can append arguments.
  const handleCompletionSelect = useCallback(
    (item: CompletionItem, fillOnly?: boolean) => {
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

      // Commands can execute immediately
      if (item.type === 'command') {
        const itemId = item.id;

        // Helper to clear trigger text from input
        const clearTriggerText = () => {
          const text = inputElement.textContent || '';
          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) {
            // Fallback: just clear everything
            inputElement.textContent = '';
            setInputText('');
            return;
          }

          // Find and remove the slash command trigger
          const range = selection.getRangeAt(0);
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

          const textBeforeCursor = text.substring(0, cursorPos);
          const slashPos = textBeforeCursor.lastIndexOf('/');
          if (slashPos >= 0) {
            const newText =
              text.substring(0, slashPos) + text.substring(cursorPos);
            inputElement.textContent = newText;
            setInputText(newText);
          }
        };

        if (itemId === 'login') {
          clearTriggerText();
          vscode.postMessage({ type: 'login', data: {} });
          completion.closeCompletion();
          return;
        }

        if (itemId === 'model') {
          clearTriggerText();
          setShowModelSelector(true);
          completion.closeCompletion();
          return;
        }

        // Handle slash commands by either invoking a local action or sending
        // them as a message to the ACP session.
        // Skip when fillOnly (Tab) — let the generic insertion path fill the
        // command text so the user can keep typing arguments.
        const slashCommand = slashCommands.find(
          (command) => command.name === itemId,
        );
        if (slashCommand && !fillOnly) {
          // Clear the trigger text since we're sending the command
          clearTriggerText();
          vscode.postMessage({
            type: 'sendMessage',
            data: { text: `/${slashCommand.name}` },
          });
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
      // Only consider slash as trigger if we're in slash command mode
      const slashPos =
        completion.triggerChar === '/' ? textBeforeCursor.lastIndexOf('/') : -1;
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
    [
      completion,
      inputFieldRef,
      setInputText,
      fileContext,
      vscode,
      slashCommands,
    ],
  );

  // Handle model selection
  const handleModelSelect = useCallback(
    (modelId: string) => {
      vscode.postMessage({
        type: 'setModel',
        data: { modelId },
      });
    },
    [vscode],
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
    (e: React.FormEvent | React.KeyboardEvent, explicitText?: string) => {
      setPinnedToBottom(true);

      const container = messagesContainerRef.current;
      if (container) {
        const top = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top });
      }

      submitMessage(e, explicitText);
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
      timestamp: toolCall.timestamp ?? 0,
    }));

    // Completed tool calls
    const completedTools = completedToolCalls
      .filter(hasToolCallOutput)
      .map((toolCall) => ({
        type: 'completed-tool-call' as const,
        data: toolCall,
        timestamp: toolCall.timestamp ?? 0,
      }));

    // Merge and sort by timestamp to ensure messages and tool calls are interleaved
    return [...regularMessages, ...inProgressTools, ...completedTools].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );
  }, [messageHandling.messages, inProgressToolCalls, completedToolCalls]);

  console.log('[App] Rendering messages:', allMessages);

  // Render all messages and tool calls
  const renderMessages = useCallback<() => React.ReactNode>(() => {
    let imageIndex = 0;
    return allMessages.map((item, index) => {
      switch (item.type) {
        case 'message': {
          const msg = item.data as TextMessage;
          const handleFileClick = (path: string): void => {
            vscode.postMessage({
              type: 'openFile',
              data: { path },
            });
          };

          if (msg.kind === 'image' && msg.imagePath) {
            imageIndex += 1;
            return (
              <ImageMessageRenderer
                key={`message-${index}`}
                msg={msg as WebViewImageMessage}
                imageIndex={imageIndex}
              />
            );
          }

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
          return (
            <ToolCall
              key={`toolcall-${(item.data as ToolCallData).toolCallId}-${item.type}`}
              toolCall={item.data as ToolCallData}
            />
          );
        }

        default:
          return null;
      }
    });
  }, [allMessages, vscode]);

  const hasContent =
    messageHandling.messages.length > 0 ||
    messageHandling.isStreaming ||
    inProgressToolCalls.length > 0 ||
    completedToolCalls.length > 0 ||
    planEntries.length > 0 ||
    allMessages.length > 0;

  return (
    <div className="chat-container relative">
      {/* Top-level loading overlay */}
      {isLoading && (
        <div className="bg-background/80 absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="text-center">
            <div className="border-primary mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-b-2"></div>
            <p className="text-muted-foreground text-sm">
              Preparing Qwen Code...
            </p>
          </div>
        </div>
      )}

      <SessionSelector
        visible={sessionManagement.showSessionSelector}
        sessions={sessionManagement.filteredSessions}
        currentSessionId={sessionManagement.currentSessionId}
        searchQuery={sessionManagement.sessionSearchQuery}
        onSearchChange={sessionManagement.setSessionSearchQuery}
        onSelectSession={(sessionId: string) => {
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
        onNewSession={() =>
          sessionManagement.handleNewQwenSession(modelInfo?.modelId ?? null)
        }
      />

      <div
        ref={messagesContainerRef}
        className="chat-messages messages-container flex-1 overflow-y-auto overflow-x-hidden pt-5 pr-5 pl-5 pb-[140px] flex flex-col relative min-w-0 focus:outline-none [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:hover:bg-white/30 [&>*]:flex [&>*]:gap-0 [&>*]:items-start [&>*]:text-left [&>*]:py-2 [&>*:not(:last-child)]:pb-[8px] [&>*]:flex-col [&>*]:relative [&>*]:animate-[fadeIn_0.2s_ease-in]"
      >
        {!hasContent && !isLoading ? (
          isAuthenticated === false ? (
            <Onboarding
              onLogin={() => {
                vscode.postMessage({ type: 'login', data: {} });
                messageHandling.setWaitingForResponse(
                  'Logging in to Qwen Code...',
                );
              }}
            />
          ) : isAuthenticated === null ? (
            <EmptyState loadingMessage="Checking login status…" />
          ) : (
            <EmptyState isAuthenticated />
          )
        ) : (
          <>
            {/* Render all messages and tool calls */}
            {renderMessages()}

            {/* Waiting message positioned fixed above the input form to avoid layout shifts */}
            {messageHandling.isWaitingForResponse &&
              messageHandling.loadingMessage && (
                <div className="waiting-message-slot min-h-[28px]">
                  <WaitingMessage
                    loadingMessage={messageHandling.loadingMessage}
                  />
                </div>
              )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {isAuthenticated && (
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
          contextUsage={contextUsage}
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
                  const inputRect =
                    inputFieldRef.current.getBoundingClientRect();
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
          onPaste={handlePaste}
          completionIsOpen={completion.isOpen}
          completionItems={completion.items}
          onCompletionSelect={handleCompletionSelect}
          onCompletionFill={(item) => handleCompletionSelect(item, true)}
          onCompletionClose={completion.closeCompletion}
          canSubmit={canSubmit}
          extraContent={
            attachedImages.length > 0 ? (
              <ImagePreview
                images={attachedImages}
                onRemove={handleRemoveImage}
              />
            ) : null
          }
          showModelSelector={showModelSelector}
          availableModels={availableModels}
          currentModelId={modelInfo?.modelId}
          onSelectModel={handleModelSelect}
          onCloseModelSelector={() => setShowModelSelector(false)}
        />
      )}

      {isAuthenticated && permissionRequest && (
        <PermissionDrawer
          isOpen={!!permissionRequest}
          options={permissionRequest.options}
          toolCall={permissionRequest.toolCall}
          onResponse={handlePermissionResponse}
          onClose={() => setPermissionRequest(null)}
        />
      )}

      {isAuthenticated && askUserQuestionRequest && (
        <AskUserQuestionDialog
          questions={askUserQuestionRequest.questions}
          onSubmit={handleAskUserQuestionResponse}
          onCancel={handleAskUserQuestionCancel}
        />
      )}
    </div>
  );
};
