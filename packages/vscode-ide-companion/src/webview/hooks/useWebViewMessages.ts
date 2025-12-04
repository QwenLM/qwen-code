/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback } from 'react';
import { useVSCode } from './useVSCode.js';
import type { Conversation } from '../../storage/conversationStore.js';
import type {
  PermissionOption,
  ToolCall as PermissionToolCall,
} from '../components/PermissionRequest.js';
import type { PlanEntry } from '../components/PlanDisplay.js';
import type { ToolCallUpdate } from '../types/toolCall.js';

interface UseWebViewMessagesProps {
  // Session management
  sessionManagement: {
    currentSessionId: string | null;
    setQwenSessions: (sessions: Array<Record<string, unknown>>) => void;
    setCurrentSessionId: (id: string | null) => void;
    setCurrentSessionTitle: (title: string) => void;
    setShowSessionSelector: (show: boolean) => void;
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
    clearWaitingForResponse: () => void;
  };

  // Tool calls
  handleToolCallUpdate: (update: ToolCallUpdate) => void;
  clearToolCalls: () => void;

  // Plan
  setPlanEntries: (entries: PlanEntry[]) => void;

  // Permission
  handlePermissionRequest: (request: {
    options: PermissionOption[];
    toolCall: PermissionToolCall;
  }) => void;

  // Input
  inputFieldRef: React.RefObject<HTMLDivElement>;
  setInputText: (text: string) => void;
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
}: UseWebViewMessagesProps) => {
  // VS Code API for posting messages back to the extension host
  const vscode = useVSCode();
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

        // case 'cliNotInstalled': {
        //   // Show CLI not installed message
        //   const errorMsg =
        //     (message?.data?.error as string) ||
        //     'Qwen Code CLI is not installed. Please install it to enable full functionality.';

        //   handlers.messageHandling.addMessage({
        //     role: 'assistant',
        //     content: `Qwen CLI is not installed. Please install it to enable full functionality.\n\nError: ${errorMsg}\n\nInstallation instructions:\n1. Install via npm:\n   npm install -g @qwen-code/qwen-code@latest\n\n2. After installation, reload VS Code or restart the extension.`,
        //     timestamp: Date.now(),
        //   });
        //   break;
        // }

        // case 'agentConnected': {
        //   // Agent connected successfully
        //   handlers.messageHandling.clearWaitingForResponse();
        //   break;
        // }

        // case 'agentConnectionError': {
        //   // Agent connection failed
        //   handlers.messageHandling.clearWaitingForResponse();
        //   const errorMsg =
        //     (message?.data?.message as string) ||
        //     'Failed to connect to Qwen agent.';

        //   handlers.messageHandling.addMessage({
        //     role: 'assistant',
        //     content: `Failed to connect to Qwen agent: ${errorMsg}\nYou can still use the chat UI, but messages won't be sent to AI.`,
        //     timestamp: Date.now(),
        //   });
        //   break;
        // }

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
            } catch (err) {
              // no-op: stream might not have been started
              console.warn('[PanelManager] Failed to end streaming:', err);
            }
            try {
              handlers.messageHandling.clearWaitingForResponse();
            } catch (err) {
              // no-op: already cleared
              console.warn(
                '[PanelManager] Failed to clear waiting for response:',
                err,
              );
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

        case 'streamEnd':
          handlers.messageHandling.endStreaming();
          handlers.messageHandling.clearThinking();
          break;

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
            let kind = permToolCall.kind || 'execute';
            if (permToolCall.title) {
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
            } catch (err) {
              console.warn(
                '[useWebViewMessages] failed to push/merge plan snapshot toolcall:',
                err,
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
          // Split assistant stream at tool boundaries similar to Claude/GPT rhythm
          const status = (toolCallData.status || '').toString();
          const isStart = toolCallData.type === 'tool_call';
          const isFinalUpdate =
            toolCallData.type === 'tool_call_update' &&
            (status === 'completed' || status === 'failed');
          if (isStart || isFinalUpdate) {
            handlers.messageHandling.breakAssistantSegment();
          }
          break;
        }

        case 'qwenSessionList': {
          const sessions = message.data.sessions || [];
          handlers.sessionManagement.setQwenSessions(sessions);
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
          handlers.clearToolCalls();
          handlers.setPlanEntries([]);
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
    [inputFieldRef, setInputText, vscode],
  );

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);
};
