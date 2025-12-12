/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback } from 'react';
import { useVSCode } from './useVSCode.js';
import type { Conversation } from '../../services/conversationStore.js';
import type {
  PermissionOption,
  ToolCall as PermissionToolCall,
} from '../components/PermissionDrawer/PermissionRequest.js';
import type { ToolCallUpdate } from '../../types/chatTypes.js';
import type { ApprovalModeValue } from '../../types/acpTypes.js';
import type { PlanEntry } from '../../types/chatTypes.js';

interface UseWebViewMessagesProps {
  // Session management
  sessionManagement: {
    currentSessionId: string | null;
    setQwenSessions: (
      sessions:
        | Array<Record<string, unknown>>
        | ((
            prev: Array<Record<string, unknown>>,
          ) => Array<Record<string, unknown>>),
    ) => void;
    setCurrentSessionId: (id: string | null) => void;
    setCurrentSessionTitle: (title: string) => void;
    setShowSessionSelector: (show: boolean) => void;
    setNextCursor: (cursor: number | undefined) => void;
    setHasMore: (hasMore: boolean) => void;
    setIsLoading: (loading: boolean) => void;
    handleSaveSessionResponse: (response: {
      success: boolean;
      message?: string;
    }) => void;
  };

  // File context
  fileContext: {
    setActiveFileName: (name: string | null) => void;
    setActiveFilePath: (path: string | null) => void;
    setActiveSelection: (
      selection: { startLine: number; endLine: number } | null,
    ) => void;
    setWorkspaceFiles: (
      files: Array<{
        id: string;
        label: string;
        description: string;
        path: string;
      }>,
    ) => void;
    addFileReference: (name: string, path: string) => void;
  };

  // Message handling
  messageHandling: {
    setMessages: (
      messages: Array<{
        role: 'user' | 'assistant' | 'thinking';
        content: string;
        timestamp: number;
        fileContext?: {
          fileName: string;
          filePath: string;
          startLine?: number;
          endLine?: number;
        };
      }>,
    ) => void;
    addMessage: (message: {
      role: 'user' | 'assistant' | 'thinking';
      content: string;
      timestamp: number;
    }) => void;
    clearMessages: () => void;
    startStreaming: (timestamp?: number) => void;
    appendStreamChunk: (chunk: string) => void;
    endStreaming: () => void;
    breakAssistantSegment: () => void;
    appendThinkingChunk: (chunk: string) => void;
    clearThinking: () => void;
    setWaitingForResponse: (message: string) => void;
    clearWaitingForResponse: () => void;
  };

  // Tool calls
  handleToolCallUpdate: (update: ToolCallUpdate) => void;
  clearToolCalls: () => void;

  // Plan
  setPlanEntries: (entries: PlanEntry[]) => void;

  // Permission
  // When request is non-null, open/update the permission drawer.
  // When null, close the drawer (used when extension simulates a choice).
  handlePermissionRequest: (
    request: {
      options: PermissionOption[];
      toolCall: PermissionToolCall;
    } | null,
  ) => void;

  // Input
  inputFieldRef: React.RefObject<HTMLDivElement>;
  setInputText: (text: string) => void;
  // Edit mode setter (maps ACP modes to UI modes)
  setEditMode?: (mode: ApprovalModeValue) => void;
}

/**
 * WebView message handling Hook
 * Handles all messages from VSCode Extension uniformly
 */
export const useWebViewMessages = ({
  sessionManagement,
  fileContext,
  messageHandling,
  handleToolCallUpdate,
  clearToolCalls,
  setPlanEntries,
  handlePermissionRequest,
  inputFieldRef,
  setInputText,
  setEditMode,
}: UseWebViewMessagesProps) => {
  // VS Code API for posting messages back to the extension host
  const vscode = useVSCode();
  // Track active long-running tool calls (execute/bash/command) so we can
  // keep the bottom "waiting" message visible until all of them complete.
  const activeExecToolCallsRef = useRef<Set<string>>(new Set());
  // Use ref to store callbacks to avoid useEffect dependency issues
  const handlersRef = useRef({
    sessionManagement,
    fileContext,
    messageHandling,
    handleToolCallUpdate,
    clearToolCalls,
    setPlanEntries,
    handlePermissionRequest,
  });

  // Track last "Updated Plan" snapshot toolcall to support merge/dedupe
  const lastPlanSnapshotRef = useRef<{
    id: string;
    text: string; // joined lines
    lines: string[];
  } | null>(null);

  const buildPlanLines = (entries: PlanEntry[]): string[] =>
    entries.map((e) => {
      const mark =
        e.status === 'completed' ? 'x' : e.status === 'in_progress' ? '-' : ' ';
      return `- [${mark}] ${e.content}`.trim();
    });

  const isSupplementOf = (
    prevLines: string[],
    nextLines: string[],
  ): boolean => {
    // Consider "supplement" = old content text collection (ignoring status) is contained in new content
    const key = (line: string) => {
      const idx = line.indexOf('] ');
      return idx >= 0 ? line.slice(idx + 2).trim() : line.trim();
    };
    const nextSet = new Set(nextLines.map(key));
    for (const pl of prevLines) {
      if (!nextSet.has(key(pl))) {
        return false;
      }
    }
    return true;
  };

  // Update refs
  useEffect(() => {
    handlersRef.current = {
      sessionManagement,
      fileContext,
      messageHandling,
      handleToolCallUpdate,
      clearToolCalls,
      setPlanEntries,
      handlePermissionRequest,
    };
  });

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const message = event.data;
      const handlers = handlersRef.current;

      switch (message.type) {
        case 'modeInfo': {
          // Initialize UI mode from ACP initialize
          try {
            const current = (message.data?.currentModeId ||
              'default') as ApprovalModeValue;
            setEditMode?.(current);
          } catch (_error) {
            // best effort
          }
          break;
        }

        case 'modeChanged': {
          try {
            const modeId = (message.data?.modeId ||
              'default') as ApprovalModeValue;
            setEditMode?.(modeId);
          } catch (_error) {
            // Ignore error when setting mode
          }
          break;
        }
        case 'loginSuccess': {
          // Clear loading state and show a short assistant notice
          handlers.messageHandling.clearWaitingForResponse();
          handlers.messageHandling.addMessage({
            role: 'assistant',
            content: 'Successfully logged in. You can continue chatting.',
            timestamp: Date.now(),
          });
          break;
        }

        case 'agentConnected': {
          // Agent connected successfully; clear any pending spinner
          handlers.messageHandling.clearWaitingForResponse();
          break;
        }

        case 'agentConnectionError': {
          // Agent connection failed; surface the error and unblock the UI
          handlers.messageHandling.clearWaitingForResponse();
          const errorMsg =
            (message?.data?.message as string) ||
            'Failed to connect to Qwen agent.';

          handlers.messageHandling.addMessage({
            role: 'assistant',
            content: `Failed to connect to Qwen agent: ${errorMsg}\nYou can still use the chat UI, but messages won't be sent to AI.`,
            timestamp: Date.now(),
          });
          break;
        }

        case 'loginError': {
          // Clear loading state and show error notice
          handlers.messageHandling.clearWaitingForResponse();
          const errorMsg =
            (message?.data?.message as string) ||
            'Login failed. Please try again.';
          handlers.messageHandling.addMessage({
            role: 'assistant',
            content: errorMsg,
            timestamp: Date.now(),
          });
          break;
        }

        case 'conversationLoaded': {
          const conversation = message.data as Conversation;
          handlers.messageHandling.setMessages(conversation.messages);
          break;
        }

        case 'message': {
          const msg = message.data as {
            role?: 'user' | 'assistant' | 'thinking';
            content?: string;
            timestamp?: number;
          };
          handlers.messageHandling.addMessage(
            msg as unknown as Parameters<
              typeof handlers.messageHandling.addMessage
            >[0],
          );
          // Robustness: if an assistant message arrives outside the normal stream
          // pipeline (no explicit streamEnd), ensure we clear streaming/waiting states
          if (msg.role === 'assistant') {
            try {
              handlers.messageHandling.endStreaming();
            } catch (_error) {
              // no-op: stream might not have been started
              console.warn('[PanelManager] Failed to end streaming:', _error);
            }
            // Important: Do NOT blindly clear the waiting message if there are
            // still active tool calls running. We keep the waiting indicator
            // tied to tool-call lifecycle instead.
            if (activeExecToolCallsRef.current.size === 0) {
              try {
                handlers.messageHandling.clearWaitingForResponse();
              } catch (_error) {
                // no-op: already cleared
                console.warn(
                  '[PanelManager] Failed to clear waiting for response:',
                  _error,
                );
              }
            }
          }
          break;
        }

        case 'streamStart':
          handlers.messageHandling.startStreaming(
            (message.data as { timestamp?: number } | undefined)?.timestamp,
          );
          break;

        case 'streamChunk': {
          handlers.messageHandling.appendStreamChunk(message.data.chunk);
          break;
        }

        case 'thoughtChunk': {
          const chunk = message.data.content || message.data.chunk || '';
          handlers.messageHandling.appendThinkingChunk(chunk);
          break;
        }

        case 'streamEnd': {
          // Always end local streaming state and collapse any thoughts
          handlers.messageHandling.endStreaming();
          handlers.messageHandling.clearThinking();

          // If the stream ended due to explicit user cancel, proactively
          // clear the waiting indicator and reset any tracked exec calls.
          // This avoids the UI being stuck with the Stop button visible
          // after rejecting a permission request.
          try {
            const reason = (
              (message.data as { reason?: string } | undefined)?.reason || ''
            ).toLowerCase();
            if (reason === 'user_cancelled') {
              activeExecToolCallsRef.current.clear();
              handlers.messageHandling.clearWaitingForResponse();
              break;
            }
          } catch (_error) {
            // best-effort
          }

          // Otherwise, clear the generic waiting indicator only if there are
          // no active long-running tool calls. If there are still active
          // execute/bash/command calls, keep the hint visible.
          if (activeExecToolCallsRef.current.size === 0) {
            handlers.messageHandling.clearWaitingForResponse();
          }
          break;
        }

        case 'error':
          handlers.messageHandling.clearWaitingForResponse();
          break;

        case 'permissionRequest': {
          handlers.handlePermissionRequest(message.data);

          const permToolCall = message.data?.toolCall as {
            toolCallId?: string;
            kind?: string;
            title?: string;
            status?: string;
            content?: unknown[];
            locations?: Array<{ path: string; line?: number | null }>;
          };

          if (permToolCall?.toolCallId) {
            // Infer kind more robustly for permission preview:
            // - If content contains a diff entry, force 'edit' so the EditToolCall can handle it properly
            // - Else try title-based hints; fall back to provided kind or 'execute'
            let kind = permToolCall.kind || 'execute';
            const contentArr = (permToolCall.content as unknown[]) || [];
            const hasDiff = Array.isArray(contentArr)
              ? contentArr.some(
                  (c: unknown) =>
                    !!c &&
                    typeof c === 'object' &&
                    (c as { type?: string }).type === 'diff',
                )
              : false;
            if (hasDiff) {
              kind = 'edit';

              // Auto-open diff view for edit operations with diff content
              // This replaces the useEffect auto-trigger in EditToolCall component
              const diffContent = contentArr.find(
                (c: unknown) =>
                  !!c &&
                  typeof c === 'object' &&
                  (c as { type?: string }).type === 'diff',
              ) as
                | { path?: string; oldText?: string; newText?: string }
                | undefined;

              if (
                diffContent?.path &&
                diffContent?.oldText !== undefined &&
                diffContent?.newText !== undefined
              ) {
                vscode.postMessage({
                  type: 'openDiff',
                  data: {
                    path: diffContent.path,
                    oldText: diffContent.oldText,
                    newText: diffContent.newText,
                  },
                });
              }
            } else if (permToolCall.title) {
              const title = permToolCall.title.toLowerCase();
              if (title.includes('touch') || title.includes('echo')) {
                kind = 'execute';
              } else if (title.includes('read') || title.includes('cat')) {
                kind = 'read';
              } else if (title.includes('write') || title.includes('edit')) {
                kind = 'edit';
              }
            }

            const normalizedStatus = (
              permToolCall.status === 'pending' ||
              permToolCall.status === 'in_progress' ||
              permToolCall.status === 'completed' ||
              permToolCall.status === 'failed'
                ? permToolCall.status
                : 'pending'
            ) as ToolCallUpdate['status'];

            handlers.handleToolCallUpdate({
              type: 'tool_call',
              toolCallId: permToolCall.toolCallId,
              kind,
              title: permToolCall.title,
              status: normalizedStatus,
              content: permToolCall.content as ToolCallUpdate['content'],
              locations: permToolCall.locations,
            });

            // Split assistant stream so subsequent chunks start a new assistant message
            handlers.messageHandling.breakAssistantSegment();
          }
          break;
        }

        case 'permissionResolved': {
          // Extension proactively resolved a pending permission; close drawer.
          try {
            handlers.handlePermissionRequest(null);
          } catch (_error) {
            console.warn(
              '[useWebViewMessages] failed to close permission UI:',
              _error,
            );
          }
          break;
        }

        case 'plan':
          if (message.data.entries && Array.isArray(message.data.entries)) {
            const entries = message.data.entries as PlanEntry[];
            handlers.setPlanEntries(entries);

            // Generate new snapshot text
            const lines = buildPlanLines(entries);
            const text = lines.join('\n');
            const prev = lastPlanSnapshotRef.current;

            // 1) Identical -> Skip
            if (prev && prev.text === text) {
              break;
            }

            try {
              const ts = Date.now();

              // 2) Supplement or status update -> Merge to previous (use tool_call_update to override content)
              if (prev && isSupplementOf(prev.lines, lines)) {
                handlers.handleToolCallUpdate({
                  type: 'tool_call_update',
                  toolCallId: prev.id,
                  kind: 'todo_write',
                  title: 'Updated Plan',
                  status: 'completed',
                  content: [
                    {
                      type: 'content',
                      content: { type: 'text', text },
                    },
                  ],
                  timestamp: ts,
                });
                lastPlanSnapshotRef.current = { id: prev.id, text, lines };
              } else {
                // 3) Other cases -> Add a new history card
                const toolCallId = `plan-snapshot-${ts}`;
                handlers.handleToolCallUpdate({
                  type: 'tool_call',
                  toolCallId,
                  kind: 'todo_write',
                  title: 'Updated Plan',
                  status: 'completed',
                  content: [
                    {
                      type: 'content',
                      content: { type: 'text', text },
                    },
                  ],
                  timestamp: ts,
                });
                lastPlanSnapshotRef.current = { id: toolCallId, text, lines };
              }

              // Split assistant message segments, keep rendering blocks independent
              handlers.messageHandling.breakAssistantSegment?.();
            } catch (_error) {
              console.warn(
                '[useWebViewMessages] failed to push/merge plan snapshot toolcall:',
                _error,
              );
            }
          }
          break;

        case 'toolCall':
        case 'toolCallUpdate': {
          const toolCallData = message.data;
          if (toolCallData.sessionUpdate && !toolCallData.type) {
            toolCallData.type = toolCallData.sessionUpdate;
          }
          handlers.handleToolCallUpdate(toolCallData);

          // Split assistant stream
          const status = (toolCallData.status || '').toString();
          const isStart = toolCallData.type === 'tool_call';
          const isFinalUpdate =
            toolCallData.type === 'tool_call_update' &&
            (status === 'completed' || status === 'failed');
          if (isStart || isFinalUpdate) {
            handlers.messageHandling.breakAssistantSegment();
          }

          // While long-running tools (e.g., execute/bash/command) are in progress,
          // surface a lightweight loading indicator and expose the Stop button.
          try {
            const kind = (toolCallData.kind || '').toString().toLowerCase();
            const isExec =
              kind === 'execute' || kind === 'bash' || kind === 'command';

            if (isExec) {
              const id = (toolCallData.toolCallId || '').toString();

              // Maintain the active set by status
              if (status === 'pending' || status === 'in_progress') {
                activeExecToolCallsRef.current.add(id);

                // Build a helpful hint from rawInput
                const rawInput = toolCallData.rawInput;
                let cmd = '';
                if (typeof rawInput === 'string') {
                  cmd = rawInput;
                } else if (rawInput && typeof rawInput === 'object') {
                  const maybe = rawInput as { command?: string };
                  cmd = maybe.command || '';
                }
                const hint = cmd ? `Running: ${cmd}` : 'Running command...';
                handlers.messageHandling.setWaitingForResponse(hint);
              } else if (status === 'completed' || status === 'failed') {
                activeExecToolCallsRef.current.delete(id);
              }

              // If no active exec tool remains, clear the waiting message.
              if (activeExecToolCallsRef.current.size === 0) {
                handlers.messageHandling.clearWaitingForResponse();
              }
            }
          } catch (_error) {
            // Best-effort UI hint; ignore errors
          }
          break;
        }

        case 'qwenSessionList': {
          const sessions =
            (message.data.sessions as Array<Record<string, unknown>>) || [];
          const append = Boolean(message.data.append);
          const nextCursor = message.data.nextCursor as number | undefined;
          const hasMore = Boolean(message.data.hasMore);

          handlers.sessionManagement.setQwenSessions(
            (prev: Array<Record<string, unknown>>) =>
              append ? [...prev, ...sessions] : sessions,
          );
          handlers.sessionManagement.setNextCursor(nextCursor);
          handlers.sessionManagement.setHasMore(hasMore);
          handlers.sessionManagement.setIsLoading(false);
          if (
            handlers.sessionManagement.currentSessionId &&
            sessions.length > 0
          ) {
            const currentSession = sessions.find(
              (s: Record<string, unknown>) =>
                (s.id as string) ===
                  handlers.sessionManagement.currentSessionId ||
                (s.sessionId as string) ===
                  handlers.sessionManagement.currentSessionId,
            );
            if (currentSession) {
              const title =
                (currentSession.title as string) ||
                (currentSession.name as string) ||
                'Past Conversations';
              handlers.sessionManagement.setCurrentSessionTitle(title);
            }
          }
          break;
        }

        case 'qwenSessionSwitched':
          handlers.sessionManagement.setShowSessionSelector(false);
          if (message.data.sessionId) {
            handlers.sessionManagement.setCurrentSessionId(
              message.data.sessionId as string,
            );
          }
          if (message.data.session) {
            const session = message.data.session as Record<string, unknown>;
            const title =
              (session.title as string) ||
              (session.name as string) ||
              'Past Conversations';
            handlers.sessionManagement.setCurrentSessionTitle(title);
            // Update the VS Code webview tab title as well
            vscode.postMessage({ type: 'updatePanelTitle', data: { title } });
          }
          if (message.data.messages) {
            handlers.messageHandling.setMessages(message.data.messages);
          } else {
            handlers.messageHandling.clearMessages();
          }

          // Clear any waiting message that might be displayed from previous session
          handlers.messageHandling.clearWaitingForResponse();

          // Clear active tool calls tracking
          activeExecToolCallsRef.current.clear();

          // Clear and restore tool calls if provided in session data
          handlers.clearToolCalls();
          if (message.data.toolCalls && Array.isArray(message.data.toolCalls)) {
            message.data.toolCalls.forEach((toolCall: unknown) => {
              if (toolCall && typeof toolCall === 'object') {
                handlers.handleToolCallUpdate(toolCall as ToolCallUpdate);
              }
            });
          }

          // Restore plan entries if provided
          if (
            message.data.planEntries &&
            Array.isArray(message.data.planEntries)
          ) {
            handlers.setPlanEntries(message.data.planEntries);
          } else {
            handlers.setPlanEntries([]);
          }
          lastPlanSnapshotRef.current = null;
          break;

        case 'conversationCleared':
          handlers.messageHandling.clearMessages();
          handlers.clearToolCalls();
          handlers.sessionManagement.setCurrentSessionId(null);
          handlers.sessionManagement.setCurrentSessionTitle(
            'Past Conversations',
          );
          // Reset the VS Code tab title to default label
          vscode.postMessage({
            type: 'updatePanelTitle',
            data: { title: 'Qwen Code' },
          });
          lastPlanSnapshotRef.current = null;
          break;

        case 'sessionTitleUpdated': {
          const sessionId = message.data?.sessionId as string;
          const title = message.data?.title as string;
          if (sessionId && title) {
            handlers.sessionManagement.setCurrentSessionId(sessionId);
            handlers.sessionManagement.setCurrentSessionTitle(title);
            // Ask extension host to reflect this title in the tab label
            vscode.postMessage({ type: 'updatePanelTitle', data: { title } });
          }
          break;
        }

        case 'activeEditorChanged': {
          const fileName = message.data?.fileName as string | null;
          const filePath = message.data?.filePath as string | null;
          const selection = message.data?.selection as {
            startLine: number;
            endLine: number;
          } | null;
          handlers.fileContext.setActiveFileName(fileName);
          handlers.fileContext.setActiveFilePath(filePath);
          handlers.fileContext.setActiveSelection(selection);
          break;
        }

        case 'fileAttached': {
          const attachment = message.data as {
            id: string;
            type: string;
            name: string;
            value: string;
          };

          handlers.fileContext.addFileReference(
            attachment.name,
            attachment.value,
          );

          if (inputFieldRef.current) {
            const currentText = inputFieldRef.current.textContent || '';
            const newText = currentText
              ? `${currentText} @${attachment.name} `
              : `@${attachment.name} `;
            inputFieldRef.current.textContent = newText;
            setInputText(newText);

            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(inputFieldRef.current);
            range.collapse(false);
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
          break;
        }

        case 'workspaceFiles': {
          const files = message.data?.files as Array<{
            id: string;
            label: string;
            description: string;
            path: string;
          }>;
          if (files) {
            console.log('[WebView] Received workspaceFiles:', files.length);
            handlers.fileContext.setWorkspaceFiles(files);
          }
          break;
        }

        case 'saveSessionResponse': {
          handlers.sessionManagement.handleSaveSessionResponse(message.data);
          break;
        }

        case 'cancelStreaming':
          // Handle cancel streaming request from webview
          handlers.messageHandling.endStreaming();
          handlers.messageHandling.clearWaitingForResponse();
          // Add interrupted message
          handlers.messageHandling.addMessage({
            role: 'assistant',
            content: 'Interrupted',
            timestamp: Date.now(),
          });
          break;

        default:
          break;
      }
    },
    [inputFieldRef, setInputText, vscode, setEditMode],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);
};
