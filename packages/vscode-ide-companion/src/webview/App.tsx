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
} from 'react';
import { useVSCode } from './hooks/useVSCode.js';
import { useSessionManagement } from './hooks/session/useSessionManagement.js';
import { useFileContext } from './hooks/file/useFileContext.js';
import { useMessageHandling } from './hooks/message/useMessageHandling.js';
import { useToolCalls } from './hooks/useToolCalls.js';
import { useWebViewMessages } from './hooks/useWebViewMessages.js';
import { useAcpTranscript } from './hooks/useAcpTranscript.js';
import {
  shouldSendMessage,
  useMessageSubmit,
} from './hooks/useMessageSubmit.js';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
import { stripZeroWidthSpaces } from '@qwen-code/webui';
import { Onboarding } from './components/layout/Onboarding.js';
import { type CompletionItem } from '../types/completionItemTypes.js';
import { useCompletionTrigger } from './hooks/useCompletionTrigger.js';
import {
  FileIcon,
  PermissionDrawer,
  AskUserQuestionDialog,
  ImagePreview,
  InsightProgressCard,
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
import { useImagePaste } from './hooks/useImage.js';
import { computeContextUsage } from './utils/contextUsage.js';
import { resolveFileLinkFromAnchor } from './utils/fileLinks.js';
import {
  findBlockByRowKey,
  findLastAssistantText,
  formatBlocksForCopyAll,
  getBlockCopyText,
} from './utils/copyTranscript.js';
import {
  SKILL_ITEM_ID_PREFIX,
  isSkillsSecondaryQuery,
  shouldOpenSkillsSecondaryPicker,
} from './utils/completionUtils.js';
import {
  buildSlashCommandItems,
  isExpandableSlashCommand,
} from './utils/slashCommandUtils.js';
// Lazy-load the WebShell transcript renderer so the ~17MB web-shell chunk
// stays split into its own bundle and is fetched on demand.
const WebShellTranscriptLazy = React.lazy(() =>
  import('@qwen-code/web-shell').then((module) => ({
    default: module.WebShellTranscript,
  })),
);

/** Map VS Code's body theme attribute onto the transcript's dark/light prop. */
function readVSCodeWebviewTheme(): 'dark' | 'light' {
  const kind = document.body.getAttribute('data-vscode-theme-kind') ?? '';
  return kind.includes('light') ? 'light' : 'dark';
}

/**
 * Keep a failed lazy chunk load from blanking the whole panel. The
 * transcript renderer ships as a content-hashed dynamic import, so a
 * webview retained across an extension auto-update can request chunk
 * hashes that no longer exist in the new bundle. Suspense does not catch
 * the rejected import — React rethrows it and unmounts the entire root —
 * so catch it here and show a recoverable error state instead.
 */
class TranscriptErrorBoundary extends React.Component<
  { children?: React.ReactNode },
  { hasError: boolean }
> {
  state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  private handleReload = () => {
    // A full webview reload re-requests the HTML entry and picks up the
    // current bundle, which is the reliable recovery when the stale
    // webview is pinned to chunk hashes that no longer exist.
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div
        data-testid="transcript-load-error"
        className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
      >
        <span
          className="text-sm"
          style={{ color: 'var(--app-secondary-foreground)' }}
        >
          The conversation timeline failed to load.
        </span>
        <button
          type="button"
          onClick={this.handleReload}
          className="text-sm underline"
          style={{ color: 'var(--app-secondary-foreground)' }}
        >
          Reload panel
        </button>
      </div>
    );
  }
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
    rewindToolCallsToTimestamp,
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
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [modelSelectorClearance, setModelSelectorClearance] = useState(0);
  const handleModelSelectorClearanceChange = useCallback((heightPx: number) => {
    setModelSelectorClearance(heightPx);
  }, []);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  // /insight feedback: latest structured progress update and the generated
  // report path, surfaced by the extension via insightProgress /
  // insightReportReady messages.
  const [insightProgress, setInsightProgress] = useState<{
    stage: string;
    progress: number;
    detail?: string;
  } | null>(null);
  const [insightReportPath, setInsightReportPath] = useState<string | null>(
    null,
  );
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

  const completion = useCompletionTrigger(
    inputFieldRef,
    getCompletionItems,
    showModelSelector,
  );
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
    if (!messageHandling.isStreaming && !messageHandling.isWaitingForResponse) {
      const inputElement = inputFieldRef.current;
      if (inputElement) {
        const text = stripZeroWidthSpaces(inputElement.textContent ?? '');
        setInputText(text);
        inputElement.setAttribute(
          'data-empty',
          text.trim().length === 0 ? 'true' : 'false',
        );
        inputElement.blur();
      }
      return;
    }

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
          localOnly: true,
        });
      }
    }
    // Notify extension/agent to cancel server-side work
    vscode.postMessage({
      type: 'cancelStreaming',
      data: {},
    });
  }, [inputFieldRef, messageHandling, setInputText, vscode]);

  // Message handling
  useWebViewMessages({
    sessionManagement,
    fileContext,
    messageHandling,
    handleToolCallUpdate,
    clearToolCalls,
    rewindToolCallsToTimestamp,
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
    setInsightProgress: (progress) => {
      setInsightProgress(progress);
    },
    setInsightReportPath: (path) => {
      setInsightReportPath(path);
    },
  });

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

  // Single source of truth for "a fixed overlay layer is mounted". Besides
  // the modal dialogs (PermissionDrawer / AskUserQuestionDialog /
  // AccountInfoDialog) this includes webui's SessionSelector, whose backdrop
  // and dropdown are also fixed z-[999]/z-[1000] layers. Both the
  // close-effect below and the /model open gate must use this one predicate:
  // the selector paints beneath every one of these layers, so the two must
  // never be mounted together in either direction. Keeping the check in one
  // place is what prevents the two call sites from drifting apart.
  const isOverlayActive = Boolean(
    permissionRequest ||
      askUserQuestionRequest ||
      // accountInfo doubles as the AccountInfoDialog visibility flag: it is
      // only set by the on-demand accountInfo message and reset by the
      // dialog's onClose, so truthy here means "the dialog is up".
      accountInfo ||
      sessionManagement.showSessionSelector,
  );

  // Close the model selector when an overlay takes over: while open the
  // selector consumes Enter/Escape/arrow keys via a capture-phase document
  // listener, and since it paints below the overlays those keystrokes must
  // reach the visible overlay instead. The /model open path is gated on the
  // same isOverlayActive predicate.
  //
  // useLayoutEffect, not useEffect: the close must land inside the same
  // commit as the overlay's arrival. A passive effect would leave one commit
  // in which the overlay and the selector are mounted together, with the
  // selector's capture-phase keydown listener still armed beneath the
  // visible overlay — an Enter in that window silently switches the model
  // instead of answering the overlay.
  React.useLayoutEffect(() => {
    if (showModelSelector && isOverlayActive) {
      setShowModelSelector(false);
    }
  }, [showModelSelector, isOverlayActive]);

  // Close the model selector on session takeover: the selector belongs to the
  // previous conversation, and a session switch/load/clear is an
  // overlay-equivalent takeover. A non-gesture takeover (e.g.
  // conversationLoaded on startup/reconnect) fires no mousedown, so the
  // outside-click close never runs and a stale selector would keep owning
  // Enter/Escape/arrows over the new conversation.
  useEffect(() => {
    const closeSelectorOnSessionTakeover = (event: MessageEvent) => {
      const message = event.data as { type?: string } | undefined;
      if (
        message?.type === 'conversationLoaded' ||
        message?.type === 'qwenSessionSwitched' ||
        message?.type === 'conversationCleared'
      ) {
        setShowModelSelector(false);
      }
    };
    window.addEventListener('message', closeSelectorOnSessionTakeover);
    return () =>
      window.removeEventListener('message', closeSelectorOnSessionTakeover);
  }, []);

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

        const clientActions: Record<string, () => boolean> = {
          auth: () => {
            vscode.postMessage({ type: 'auth', data: {} });
            return true;
          },
          account: () => {
            vscode.postMessage({ type: 'getAccountInfo', data: {} });
            return true;
          },
          model: () => {
            if (isOverlayActive) {
              return false;
            }
            setShowModelSelector(true);
            return true;
          },
        };

        const clientAction = clientActions[itemId];
        if (clientAction) {
          if (!clientAction()) {
            return;
          }
          clearTriggerText();
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
      isOverlayActive,
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
      if (e.key === 'Tab' && !e.shiftKey && showModelSelector) {
        e.preventDefault();
        return;
      }
      if (
        e.key === 'Tab' &&
        !e.shiftKey &&
        !isComposing &&
        !completion.isOpen &&
        !showModelSelector
      ) {
        e.preventDefault();
        handleToggleEditMode();
      }
    },
    [completion.isOpen, handleToggleEditMode, isComposing, showModelSelector],
  );

  const handleToggleThinking = useCallback(() => {
    setThinkingEnabled((prev) => !prev);
  }, []);

  const hasContent =
    messageHandling.messages.length > 0 ||
    messageHandling.isStreaming ||
    inProgressToolCalls.length > 0 ||
    completedToolCalls.length > 0 ||
    planEntries.length > 0;

  // Locally generated messages (connection/auth/generic errors and the
  // "Interrupted" cancel mark) never flow through ACP `transcriptUpdate`,
  // so the WebShell transcript cannot render them. Surface them in a
  // notice slot above the composer instead of dropping them silently.
  const localNotices = messageHandling.messages.filter(
    (message) => message.localOnly,
  );

  // The WebShell transcript has no file-open callback; intercept file-like
  // anchor clicks at the container level and route them through the
  // existing `openFile` message (handled by FileMessageHandler), restoring
  // the pre-PR behavior where file references opened in the editor.
  const handleTranscriptClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
      if (!anchor) {
        return;
      }
      const filePath = resolveFileLinkFromAnchor(anchor);
      if (!filePath) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({
        type: 'openFile',
        data: { path: filePath },
      });
    },
    [vscode],
  );

  // Open the generated /insight report in the editor via the extension's
  // existing `openInsightReport` handler.
  const handleOpenInsightReport = useCallback(() => {
    if (!insightReportPath) {
      return;
    }
    vscode.postMessage({
      type: 'openInsightReport',
      data: { path: insightReportPath },
    });
  }, [insightReportPath, vscode]);

  // VS Code applies color-theme changes to an open webview in place
  // (updating data-vscode-theme-kind on <body> without reloading it), and
  // the panel keeps its context while hidden, so a mount-time snapshot
  // would go stale. Track the live value via a body-attribute observer.
  const [webShellTheme, setWebShellTheme] = useState<'dark' | 'light'>(
    readVSCodeWebviewTheme,
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setWebShellTheme(readVSCodeWebviewTheme());
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind', 'class'],
    });
    return () => observer.disconnect();
  }, []);
  const transcriptBlocks = useAcpTranscript();

  // === Contributed copy commands (qwen-code.copyMessage/copyAllMessages/
  // copyLastReply) ===
  // The extension host routes the commands back to the webview that last
  // reported a context menu (`contextMenuTriggered`) via a `copyCommand`
  // message. The transcript container carries the `webviewSection` context
  // key the `webview/context` contributions filter on.
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const transcriptBlocksRef = useRef(transcriptBlocks);
  useEffect(() => {
    transcriptBlocksRef.current = transcriptBlocks;
  }, [transcriptBlocks]);
  const contextMenuRowKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const trackTarget = (event: MouseEvent) => {
      const container = messagesContainerRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest?.('[data-message-row-key]') as
        | HTMLElement
        | null
        | undefined;
      contextMenuRowKeyRef.current =
        container && row && container.contains(row)
          ? row.getAttribute('data-message-row-key')
          : null;
      // Notify the extension that this webview was right-clicked, so the
      // contributed copy commands route here.
      vscode.postMessage({ type: 'contextMenuTriggered', data: {} });
    };
    document.addEventListener('contextmenu', trackTarget, true);
    return () => document.removeEventListener('contextmenu', trackTarget, true);
  }, [vscode]);

  useEffect(() => {
    const handleCopyCommand = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        data?: { action?: string };
      };
      if (message?.type !== 'copyCommand') {
        return;
      }
      const blocks = transcriptBlocksRef.current;
      let text: string | null = null;
      if (message.data?.action === 'copyMessage') {
        const block = findBlockByRowKey(blocks, contextMenuRowKeyRef.current);
        text = block ? getBlockCopyText(block) : null;
      } else if (message.data?.action === 'copyAllMessages') {
        text = formatBlocksForCopyAll(blocks);
      } else if (message.data?.action === 'copyLastReply') {
        text = findLastAssistantText(blocks);
      }
      if (text) {
        vscode.postMessage({ type: 'copyToClipboard', data: { text } });
      }
    };
    window.addEventListener('message', handleCopyCommand);
    return () => window.removeEventListener('message', handleCopyCommand);
  }, [vscode]);

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
        className="flex-1 min-h-0 relative"
        onClick={handleTranscriptClick}
        // Context key the contributed copy commands filter on
        // (`when: "webviewSection == 'chat-messages'"` in package.json).
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
          <TranscriptErrorBoundary>
            <React.Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <span className="border-primary inline-block h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" />
                </div>
              }
            >
              <WebShellTranscriptLazy
                blocks={transcriptBlocks}
                theme={webShellTheme}
                // WebShellTranscript hardcodes isResponding={false}, so
                // MessageList's auto-collapse would treat the in-progress
                // turn as completed and collapse it mid-response. Disable
                // collapsing until a live isResponding prop is plumbed
                // through; the pre-PR timeline was always fully expanded.
                collapseCompletedTurns={false}
                // InputForm is now an in-flow sibling, so the transcript only
                // needs extra clearance while the selector overlaps it. The
                // WebShell list already contributes 8px of base padding; add
                // the dropdown height plus another 8px above it.
                style={
                  {
                    '--web-shell-bottom-panel-inset':
                      showModelSelector && modelSelectorClearance > 0
                        ? `${modelSelectorClearance + 8}px`
                        : '0px',
                  } as React.CSSProperties
                }
              />
            </React.Suspense>
          </TranscriptErrorBoundary>
        )}
        {(localNotices.length > 0 || insightProgress || insightReportPath) && (
          <div
            data-testid="local-message-notices"
            // The InputForm wrapper is now an in-flow sibling, so this
            // container's bottom edge IS the form's top edge. Anchor the
            // notices just above that edge so they sit right over the input
            // box without covering transcript content. z-20 keeps them above
            // the transcript but below the open model-selector dropdown
            // (z-30, see InputForm) — matching the pre-PR stacking where the
            // dropdown painted over the notices.
            className="absolute bottom-2 left-0 right-0 z-20 mx-auto flex w-full max-w-[600px] flex-col gap-1 px-4"
          >
            {insightProgress && (
              <div data-testid="insight-progress">
                <InsightProgressCard
                  stage={insightProgress.stage}
                  progress={insightProgress.progress}
                  detail={insightProgress.detail}
                />
              </div>
            )}
            {insightReportPath && (
              <div className="px-[30px] py-2">
                <div className="text-sm text-[var(--vscode-descriptionForeground)]">
                  Insight report generated at:
                </div>
                <a
                  href="#"
                  data-testid="insight-report-link"
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
            {localNotices.map((notice, index) => (
              <div
                key={`${notice.timestamp}-${index}`}
                data-testid="local-message-notice"
                className="break-words rounded border px-3 py-2 text-sm"
                style={{
                  color:
                    'var(--vscode-editorError-foreground, var(--app-secondary-foreground))',
                  borderColor: 'var(--vscode-editorError-border, transparent)',
                  backgroundColor: 'var(--vscode-editorWidget-background)',
                }}
              >
                {notice.content}
              </div>
            ))}
          </div>
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
          onSubmit={submitMessage}
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
          onModelSelectorClearance={handleModelSelectorClearanceChange}
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
