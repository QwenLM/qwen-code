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
import { stripZeroWidthSpaces } from '@qwen-code/webui';
import type { TextMessage } from './hooks/message/useMessageHandling.js';
import type { ToolCallData } from './components/messages/toolcalls/ToolCall.js';
import { ToolCall } from './components/messages/toolcalls/ToolCall.js';
import { hasToolCallOutput, shouldShowToolCall } from './utils/utils.js';
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
  InsightProgressCard,
  ImageMessageRenderer,
  ImagePreview,
  // Layout components imported directly from webui
  EmptyState,
  ChatHeader,
  SessionSelector,
} from '@qwen-code/webui';
import { InputForm } from './components/layout/InputForm.js';
import {
  AccountInfoDialog,
  type AccountInfo,
} from './components/AccountInfoDialog.js';
import { ApprovalMode, NEXT_APPROVAL_MODE } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type { PlanEntry, UsageStatsPayload } from '../types/chatTypes.js';
import type { ModelInfo, AvailableCommand } from '@agentclientprotocol/sdk';
import type { Question } from '../types/acpTypes.js';
import { useImagePaste, type WebViewImageMessage } from './hooks/useImage.js';
import { computeContextUsage } from './utils/contextUsage.js';
import {
  SKILL_ITEM_ID_PREFIX,
  isSkillsSecondaryQuery,
  shouldOpenSkillsSecondaryPicker,
} from './utils/completionUtils.js';
import {
  buildSlashCommandItems,
  isExpandableSlashCommand,
} from './utils/slashCommandUtils.js';

/**
 * Memoized message list that only re-renders when messages or callbacks change,
 * not on every keystroke in the input field.
 */
interface MessageListItem {
  type: 'message' | 'in-progress-tool-call' | 'completed-tool-call';
  data: TextMessage | ToolCallData;
  timestamp: number;
}

interface MessageListProps {
  allMessages: MessageListItem[];
  onFileClick: (path: string) => void;
  /**
   * After each render, this ref is updated with an array that maps
   * DOM child position → allMessages index, only for items that
   * actually render a DOM element (skipping nulls).
   */
  childIndexMap: React.MutableRefObject<number[]>;
}

const MessageList = React.memo<MessageListProps>(
  ({ allMessages, onFileClick, childIndexMap }) => {
    let imageIndex = 0;

    // Build child→allMessages index mapping: for each item that renders
    // a non-null element, record its allMessages index. This array's
    // position corresponds to the DOM child position in the container.
    const mapping: number[] = [];

    const elements = allMessages.map((item, index) => {
      let child: React.ReactNode;
      switch (item.type) {
        case 'message': {
          const msg = item.data as TextMessage;

          if (msg.kind === 'image' && msg.imagePath) {
            imageIndex += 1;
            child = (
              <ImageMessageRenderer
                msg={msg as WebViewImageMessage}
                imageIndex={imageIndex}
              />
            );
            break;
          }

          if (msg.role === 'thinking') {
            child = (
              <ThinkingMessage
                content={msg.content || ''}
                timestamp={msg.timestamp || 0}
                onFileClick={onFileClick}
              />
            );
            break;
          }

          if (msg.role === 'user') {
            child = (
              <UserMessage
                content={msg.content || ''}
                timestamp={msg.timestamp || 0}
                onFileClick={onFileClick}
                fileContext={msg.fileContext}
              />
            );
            break;
          }

          {
            const content = (msg.content || '').trim();
            if (!content) {
              child = null;
              break;
            }
            if (content === 'Interrupted' || content === 'Tool interrupted') {
              child = <InterruptedMessage text={content} />;
              break;
            }
            child = (
              <AssistantMessage
                content={content}
                timestamp={msg.timestamp || 0}
                onFileClick={onFileClick}
              />
            );
          }
          break;
        }

        case 'in-progress-tool-call':
        case 'completed-tool-call': {
          const tc = item.data as ToolCallData;
          if (!shouldShowToolCall(tc.kind)) {
            child = null;
            break;
          }
          child = <ToolCall toolCall={tc} />;
          break;
        }

        default:
          child = null;
      }
      // No wrapper div — message components render directly as children
      // of the scroll container, preserving the original CSS layout.
      if (child == null) {
        return null;
      }
      mapping.push(index);
      return <React.Fragment key={`msg-${index}`}>{child}</React.Fragment>;
    });

    // Update the mapping ref so the copy handler can use it
    childIndexMap.current = mapping;

    return <>{elements}</>;
  },
);

MessageList.displayName = 'MessageList';

/**
 * Given a click target inside the messages container, find which
 * allMessages index it belongs to by walking up from the target to
 * the container's direct child, then mapping through childIndexMap.
 *
 * NOTE: childIndexMap indices correspond to MessageList's DOM children
 * which must be the first N children of the container. Elements rendered
 * after MessageList (InsightProgressCard, WaitingMessage, etc.) are
 * excluded from the map and will correctly return -1.
 */
function findMessageIndex(
  target: Element,
  container: Element,
  childIndexMap: number[],
): number {
  // Walk up from the click target to find the direct child of the container.
  // This works for all message types regardless of whether they have
  // .qwen-message class (e.g. InterruptedMessage does not).
  let directChild: Element | null = target;
  while (directChild && directChild.parentElement !== container) {
    directChild = directChild.parentElement;
  }
  if (!directChild) {
    return -1;
  }

  // Find DOM child position among container's children
  const children = container.children;
  for (let i = 0; i < children.length; i++) {
    if (children[i] === directChild) {
      return i < childIndexMap.length ? childIndexMap[i] : -1;
    }
  }
  return -1;
}

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
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [insightProgress, setInsightProgress] = useState<{
    stage: string;
    progress: number;
    detail?: string;
  } | null>(null);
  const [insightReportPath, setInsightReportPath] = useState<string | null>(
    null,
  );
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  // Maps DOM child position → allMessages index. Built during render by
  // MessageList, only includes items that actually produce DOM elements.
  const childIndexMapRef = useRef<number[]>([]);
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
        if (availableSkills.length > 0 && isSkillsSecondaryQuery(query)) {
          const skillQuery = query.replace(/^skills\s+/i, '').toLowerCase();
          return availableSkills
            .map(
              (skill) =>
                ({
                  id: `${SKILL_ITEM_ID_PREFIX}${skill}`,
                  label: skill,
                  type: 'command' as const,
                  group: 'Skills',
                  value: `skills ${skill}`,
                }) satisfies CompletionItem,
            )
            .filter((item) => item.label.toLowerCase().includes(skillQuery));
        }

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
            id: 'auth',
            label: '/auth',
            description: 'Configure Coding Plan or API Key',
            type: 'command',
            group: 'Account',
          },
          {
            id: 'account',
            label: 'Account',
            description: 'Show current account and authentication info',
            type: 'command',
            group: 'Account',
          },
        ];

        const slashCommandItems = buildSlashCommandItems(
          query,
          availableCommands,
        );

        // Combine all commands
        const allCommands = [
          ...modelGroupItems,
          ...accountGroupItems,
          ...slashCommandItems,
        ];

        // Filter by query
        return allCommands.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(query.toLowerCase()) ||
            (cmd.description &&
              cmd.description.toLowerCase().includes(query.toLowerCase())),
        );
      }
    },
    [fileContext, availableCommands, availableSkills, modelInfo?.name],
  );

  const completion = useCompletionTrigger(inputFieldRef, getCompletionItems);
  const {
    isOpen: completionIsOpen,
    triggerChar: completionTriggerChar,
    query: completionQuery,
    items: completionItems,
    closeCompletion,
    openCompletion,
    refreshCompletion,
  } = completion;

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
    if (completionIsOpen && completionTriggerChar === '@') {
      // Only refresh items; do not change other completion state to avoid re-renders loops
      refreshCompletion();
    }
  }, [
    workspaceFilesSignature,
    completionIsOpen,
    completionTriggerChar,
    completionQuery,
    refreshCompletion,
  ]);

  useEffect(() => {
    if (
      completionIsOpen &&
      completionTriggerChar === '/' &&
      isSkillsSecondaryQuery(completionQuery)
    ) {
      refreshCompletion();
    }
  }, [
    availableSkills,
    completionIsOpen,
    completionTriggerChar,
    completionQuery,
    refreshCompletion,
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
    setAvailableSkills: (skills) => {
      setAvailableSkills(skills);
    },
    setAvailableModels: (models) => {
      setAvailableModels(models);
    },
    setAccountInfo: (info) => {
      setAccountInfo(info);
    },
    setInsightReportPath,
    setInsightProgress,
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
        closeCompletion();
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

        // Client-side commands that trigger extension actions directly
        // instead of being sent to the agent as messages.
        const clientActions: Record<string, () => void> = {
          auth: () => vscode.postMessage({ type: 'auth', data: {} }),
          account: () =>
            vscode.postMessage({ type: 'getAccountInfo', data: {} }),
          model: () => setShowModelSelector(true),
        };

        const clientAction = clientActions[itemId];
        if (clientAction) {
          clearTriggerText();
          clientAction();
          closeCompletion();
          return;
        }

        // For server-provided slash commands, decide based on the `input`
        // field: commands without input (input == null) auto-submit
        // immediately; commands that accept input fall through to the generic
        // insertion path so users can type arguments before submitting.
        // Special case: /skills always uses fill behavior to allow the
        // secondary skill picker to appear.
        const serverCmd = availableCommands.find((c) => c.name === itemId);
        const isSkillsCmd = shouldOpenSkillsSecondaryPicker(
          item,
          availableSkills,
        );
        if (
          serverCmd &&
          !isSkillsCmd &&
          !isExpandableSlashCommand(serverCmd.name)
        ) {
          if (!serverCmd.input && !fillOnly) {
            clearTriggerText();
            vscode.postMessage({
              type: 'sendMessage',
              data: { text: `/${serverCmd.name}` },
            });
            closeCompletion();
            return;
          }
          // Command accepts input — fall through to fill the input box.
        }

        // Handle secondary skill selection — send `/skills <name>` with
        // optional trailing user text
        if (itemId.startsWith(SKILL_ITEM_ID_PREFIX) && !fillOnly) {
          clearTriggerText();
          const value =
            typeof item.value === 'string'
              ? item.value
              : itemId.slice(SKILL_ITEM_ID_PREFIX.length);
          vscode.postMessage({
            type: 'sendMessage',
            data: { text: `/${value}` },
          });
          closeCompletion();
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

      // Current text and cursor — strip U+200B height placeholder so it
      // does not contaminate the inserted completion text.
      const rawText = inputElement.textContent || '';
      const text = stripZeroWidthSpaces(rawText);
      const range = selection.getRangeAt(0);

      // Compute total text offset for contentEditable.  The DOM offsets
      // are based on rawText (which may contain U+200B), so we compute the
      // raw cursor position first and then adjust for stripped characters.
      let rawCursorPos = rawText.length;
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
        rawCursorPos = offset || rawText.length;
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
        rawCursorPos = found ? offset : rawText.length;
      }
      // Adjust cursor to match the stripped text by subtracting
      // zero-width characters that appeared before the cursor.
      const zeroWidthBeforeCursor = (
        rawText.substring(0, rawCursorPos).match(/\u200B/g) || []
      ).length;
      const cursorPos = Math.max(0, rawCursorPos - zeroWidthBeforeCursor);

      // Replace from trigger to cursor with selected value
      const textBeforeCursor = text.substring(0, cursorPos);
      const atPos = textBeforeCursor.lastIndexOf('@');
      // Only consider slash as trigger if we're in slash command mode
      const slashPos =
        completionTriggerChar === '/' ? textBeforeCursor.lastIndexOf('/') : -1;
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

        if (shouldOpenSkillsSecondaryPicker(item, availableSkills)) {
          const rangeRect = newRange.getBoundingClientRect();
          const inputRect = inputElement.getBoundingClientRect();
          const position =
            rangeRect.top > 0 || rangeRect.left > 0
              ? { top: rangeRect.top, left: rangeRect.left }
              : { top: inputRect.top, left: inputRect.left };

          void openCompletion('/', `${insertValue} `, position);
          return;
        }

        if (
          completion.triggerChar === '/' &&
          isExpandableSlashCommand(insertValue.trim())
        ) {
          completion.closeCompletion();
          requestAnimationFrame(() => {
            inputElement.dispatchEvent(new Event('input', { bubbles: true }));
          });
          return;
        }
      }

      // Close the completion menu
      closeCompletion();
    },
    [
      availableCommands,
      availableSkills,
      closeCompletion,
      completion,
      completionTriggerChar,
      fileContext,
      inputFieldRef,
      openCompletion,
      setInputText,
      vscode,
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

  const handleOpenInsightReport = useCallback(() => {
    if (!insightReportPath) {
      return;
    }
    vscode.postMessage({
      type: 'openInsightReport',
      data: { path: insightReportPath },
    });
  }, [insightReportPath, vscode]);

  // Handle toggle edit mode (Default -> Auto-edit -> YOLO -> Default)
  const handleToggleEditMode = useCallback(() => {
    setEditMode((prev) => {
      const next: ApprovalModeValue = NEXT_APPROVAL_MODE[prev];

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

  // Handle Tab key to cycle approval modes when input is focused
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !isComposing &&
        !completion.isOpen
      ) {
        e.preventDefault();
        handleToggleEditMode();
      }
    },
    [completion.isOpen, handleToggleEditMode, isComposing],
  );

  const handleToggleThinking = useCallback(() => {
    setThinkingEnabled((prev) => !prev);
  }, []);

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

  const handleFileClick = useCallback(
    (path: string): void => {
      vscode.postMessage({
        type: 'openFile',
        data: { path },
      });
    },
    [vscode],
  );

  // Build a markdown code fence that won't collide with content containing backticks
  const buildFence = useCallback((content: string): string => {
    const matches = (content ?? '').match(/`+/g);
    const maxRun = matches ? Math.max(...matches.map((m) => m.length)) : 0;
    return '`'.repeat(Math.max(3, maxRun + 1));
  }, []);

  // Format a tool call's content for clipboard copy
  // wrapCodeBlock: true for Copy All (markdown), false for single Copy Message (plain text)
  const formatToolCallForCopy = useCallback(
    (tc: ToolCallData, wrapCodeBlock = false): string => {
      const parts: string[] = [];
      if (tc.content) {
        for (const c of tc.content) {
          if (c.type === 'content' && c.content?.text) {
            if (wrapCodeBlock) {
              const fence = buildFence(c.content.text);
              parts.push(`${fence}\n${c.content.text}\n${fence}`);
            } else {
              parts.push(c.content.text);
            }
          } else if (c.type === 'diff') {
            const filePath = c.path || '';
            if (c.oldText) {
              const oldLines = c.oldText
                .split('\n')
                .map((l) => `-${l}`)
                .join('\n');
              const newLines = (c.newText || '')
                .split('\n')
                .map((l) => `+${l}`)
                .join('\n');
              const diffContent = `--- ${filePath}\n+++ ${filePath}\n${oldLines}\n${newLines}`;
              if (wrapCodeBlock) {
                const fence = buildFence(diffContent);
                parts.push(`${fence}diff\n${diffContent}\n${fence}`);
              } else {
                parts.push(diffContent);
              }
            } else {
              if (wrapCodeBlock) {
                const fence = buildFence(c.newText || '');
                parts.push(
                  `${filePath}:\n${fence}\n${c.newText || ''}\n${fence}`,
                );
              } else {
                parts.push(`${filePath}:\n${c.newText || ''}`);
              }
            }
          }
        }
      }
      return parts.join('\n\n');
    },
    [buildFence],
  );

  // Track which message was right-clicked by resolving the index immediately.
  // Storing the DOM element reference would be fragile: React re-renders between
  // the right-click and the async copy command (routed via extension host) can
  // detach the element, causing findMessageIndex to fail intermittently.
  const contextMenuMsgIdxRef = useRef<number>(-1);
  useEffect(() => {
    const trackTarget = (e: MouseEvent) => {
      const container = messagesContainerRef.current;
      if (container && e.target instanceof Element) {
        contextMenuMsgIdxRef.current = findMessageIndex(
          e.target,
          container,
          childIndexMapRef.current,
        );
      }
      // Notify extension that this webview was right-clicked, so copy commands route here
      vscode.postMessage({ type: 'contextMenuTriggered', data: {} });
    };
    document.addEventListener('contextmenu', trackTarget, true);
    return () => document.removeEventListener('contextmenu', trackTarget, true);
  }, [vscode]);

  // Copy text via the extension host's clipboard API (more reliable than navigator.clipboard in webview)
  const copyToClipboard = useCallback(
    (text: string) => {
      vscode.postMessage({ type: 'copyToClipboard', data: { text } });
    },
    [vscode],
  );

  // Handle copy commands from VSCode native context menu
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type !== 'copyCommand') {
        return;
      }

      const { action } = message.data as { action: string };

      if (action === 'copyMessage') {
        const idx = contextMenuMsgIdxRef.current;
        if (idx >= 0 && idx < allMessages.length) {
          const item = allMessages[idx];
          if (item.type === 'message') {
            const msg = item.data as TextMessage;
            if (msg.kind === 'image' && msg.imagePath) {
              copyToClipboard(`![image](${msg.imagePath})`);
            } else {
              copyToClipboard(msg.content || '');
            }
          } else if (
            item.type === 'completed-tool-call' ||
            item.type === 'in-progress-tool-call'
          ) {
            copyToClipboard(formatToolCallForCopy(item.data as ToolCallData));
          }
        }
      } else if (action === 'copyAllMessages') {
        const parts: string[] = [];
        for (const item of allMessages) {
          if (item.type === 'message') {
            const msg = item.data as TextMessage;
            const content =
              msg.kind === 'image' && msg.imagePath
                ? `![image](${msg.imagePath})`
                : (msg.content || '').trim();
            if (!content) {
              continue;
            }
            if (msg.role === 'user') {
              parts.push(`**User:** ${content}`);
            } else if (msg.role === 'thinking') {
              parts.push(`**Thinking:** ${content}`);
            } else {
              parts.push(`**Qwen Code:** ${content}`);
            }
          } else if (
            item.type === 'completed-tool-call' ||
            item.type === 'in-progress-tool-call'
          ) {
            const tc = item.data as ToolCallData;
            if (!shouldShowToolCall(tc.kind)) {
              continue;
            }
            const text = formatToolCallForCopy(tc, true);
            if (text) {
              parts.push(`**[Tool: ${tc.kind}]**\n\n${text}`);
            }
          }
        }
        copyToClipboard(parts.join('\n\n---\n\n'));
      } else if (action === 'copyLastReply') {
        for (let i = allMessages.length - 1; i >= 0; i--) {
          const item = allMessages[i];
          if (item.type === 'message') {
            const msg = item.data as TextMessage;
            if (msg.role === 'assistant' && msg.content?.trim()) {
              copyToClipboard(msg.content);
              return;
            }
          }
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [allMessages, copyToClipboard, formatToolCallForCopy]);

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
      {(isLoading || sessionManagement.isSwitchingSession) && (
        <div className="bg-background/80 absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="text-center">
            <div className="border-primary mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-b-2"></div>
            <p className="text-muted-foreground text-sm">
              {sessionManagement.isSwitchingSession
                ? 'Loading conversation...'
                : 'Preparing Qwen Code...'}
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
        onRenameSession={sessionManagement.handleRenameSession}
        onDeleteSession={sessionManagement.handleDeleteSession}
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
        data-vscode-context={
          hasContent ? '{"webviewSection": "chat-messages"}' : undefined
        }
      >
        {!hasContent && !isLoading && !sessionManagement.isSwitchingSession ? (
          isAuthenticated === false ? (
            <Onboarding />
          ) : isAuthenticated === null ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <span
                className="inline-block w-6 h-6 animate-spin rounded-full border-2"
                style={{
                  borderColor: 'var(--app-secondary-foreground)',
                  borderTopColor: 'transparent',
                }}
              />
              <span
                className="text-sm"
                style={{ color: 'var(--app-secondary-foreground)' }}
              >
                Preparing Qwen Code...
              </span>
            </div>
          ) : (
            <EmptyState isAuthenticated />
          )
        ) : (
          <>
            {/* Render all messages and tool calls */}
            <MessageList
              allMessages={allMessages}
              onFileClick={handleFileClick}
              childIndexMap={childIndexMapRef}
            />

            {insightProgress && (
              <InsightProgressCard
                stage={insightProgress.stage}
                progress={insightProgress.progress}
                detail={insightProgress.detail}
              />
            )}

            {insightReportPath && (
              <div className="px-[30px] py-2">
                <div className="text-sm text-[var(--vscode-descriptionForeground)]">
                  Insight report generated at:
                </div>
                <a
                  href="#"
                  className="mt-1 inline-block break-all text-sm text-[var(--vscode-textLink-foreground)] underline decoration-[color-mix(in_srgb,var(--vscode-textLink-foreground)_55%,transparent)] underline-offset-2 hover:text-[var(--vscode-textLink-activeForeground)]"
                  onClick={(event) => {
                    event.preventDefault();
                    handleOpenInsightReport();
                  }}
                >
                  {insightReportPath}
                </a>
              </div>
            )}

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
          onKeyDown={handleInputKeyDown}
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

              await openCompletion('/', '', position);
            }
          }}
          onAttachContext={handleAttachContextClick}
          onPaste={handlePaste}
          completionIsOpen={completionIsOpen}
          completionItems={completionItems}
          onCompletionSelect={handleCompletionSelect}
          onCompletionFill={(item) => handleCompletionSelect(item, true)}
          onCompletionClose={closeCompletion}
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

      {accountInfo && (
        <AccountInfoDialog
          info={accountInfo}
          onClose={() => setAccountInfo(null)}
        />
      )}
    </div>
  );
};
