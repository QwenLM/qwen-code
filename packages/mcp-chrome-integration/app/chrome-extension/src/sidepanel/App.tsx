/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chrome Extension Side Panel App (daemon-direct architecture, issue #5626).
 *
 * The chat is driven entirely by `@qwen-code/webui`'s daemon React SDK: the
 * transcript, streaming state, pending permissions, and actions all come from a
 * surrounding `<DaemonSessionProvider>` (mounted by `SidePanelRoot` once the
 * local `qwen serve` daemon is confirmed reachable). There is no
 * native-messaging relay here anymore — `sendPrompt`/`cancel`/`submitPermission`
 * talk straight to the daemon over HTTP/SSE.
 */

import type React from 'react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  useConnection,
  useStreamingState,
  useTranscriptBlocks,
  useActions,
  usePendingPermissions,
  usePromptStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  WaitingMessage,
  PermissionDrawer,
  getToolCallComponent,
  ChromeToolCall,
} from '@qwen-code/webui';
import type { ToolCallData } from '@qwen-code/webui';
import { InputForm } from './platform/InputForm.js';
import { EmptyState } from './platform/EmptyState.js';
import { transcriptBlocksToItems } from './daemon/transcriptItems.js';
import { toPendingPermissionView } from './daemon/permission.js';

/** True when a tool call should render with the Chrome-specific card. */
function isChromeTool(toolCall: ToolCallData): boolean {
  const kind =
    typeof toolCall.kind === 'string' ? toolCall.kind.toLowerCase() : '';
  const rawName =
    typeof toolCall.rawInput === 'object' && toolCall.rawInput
      ? (toolCall.rawInput as Record<string, unknown>).name
      : undefined;
  const candidate = typeof rawName === 'string' ? rawName.toLowerCase() : kind;
  return candidate.startsWith('chrome_') || candidate === 'get_windows_and_tabs';
}

export const App: React.FC = () => {
  const connection = useConnection();
  const streamingState = useStreamingState();
  const promptStatus = usePromptStatus();
  const blocks = useTranscriptBlocks();
  const actions = useActions();
  const pendingPermissions = usePendingPermissions();

  const [inputText, setInputText] = useState('');
  const [isComposing, setIsComposing] = useState(false);

  const inputFieldRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const isConnected = connection.status === 'connected';
  // The daemon SDK distinguishes 'waiting' (turn submitted, no tokens yet) from
  // 'responding'/'thinking' (tokens flowing). Map them onto the side panel's
  // existing two-flag InputForm contract.
  const isWaitingForResponse = streamingState === 'waiting';
  const isStreaming =
    streamingState === 'responding' || streamingState === 'thinking';
  const isBusy = promptStatus !== 'idle' || streamingState !== 'idle';

  const items = useMemo(() => transcriptBlocksToItems(blocks), [blocks]);
  const pendingPermission = useMemo(
    () =>
      pendingPermissions.length > 0
        ? toPendingPermissionView(pendingPermissions[0])
        : null,
    [pendingPermissions],
  );

  const hasContent = items.length > 0 || isBusy;

  // Auto-scroll to the latest content as the transcript and streaming evolve.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, streamingState]);

  const handleSubmit = useCallback(
    (e: React.FormEvent | React.KeyboardEvent, explicitText?: string) => {
      e.preventDefault();
      const text = (explicitText ?? inputText).trim();
      if (!text || isBusy) return;

      setInputText('');
      if (inputFieldRef.current) {
        inputFieldRef.current.textContent = '';
      }

      // Optimistically echo the user message so it appears immediately; the
      // daemon replays its own copy, which the provider dedupes via
      // suppressOwnUserEcho.
      actions
        .sendPrompt(text, { optimisticUserMessage: true })
        .catch((err: unknown) => {
          console.error('[SidePanel] sendPrompt failed:', err);
        });
    },
    [inputText, isBusy, actions],
  );

  const handleCancel = useCallback(() => {
    actions.cancel().catch((err: unknown) => {
      console.error('[SidePanel] cancel failed:', err);
    });
  }, [actions]);

  const handlePermissionResponse = useCallback(
    (optionId: string) => {
      if (!pendingPermission) return;
      actions
        .submitPermission(pendingPermission.requestId, optionId)
        .catch((err: unknown) => {
          console.error('[SidePanel] submitPermission failed:', err);
        });
    },
    [actions, pendingPermission],
  );

  const connectionLabel = isConnected
    ? 'Connected'
    : connection.status === 'connecting'
      ? 'Connecting…'
      : connection.status === 'error'
        ? 'Error'
        : 'Disconnected';

  return (
    <div className="chat-container relative flex flex-col h-screen bg-[#1e1e1e] text-white">
      {/* Hide slash command, attach, and edit mode buttons (no-ops in this panel). */}
      <style>{`
        .composer-actions button[title*="command menu"],
        .composer-actions button[title*="Attach context"],
        .composer-actions button[aria-label*="command menu"],
        .composer-actions button[aria-label*="Attach context"] {
          display: none !important;
        }
        .composer-actions .btn-text-compact--primary:first-child {
          opacity: 0.5;
          pointer-events: none;
          cursor: not-allowed;
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h1 className="text-sm font-medium">Qwen Code</h1>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-gray-500'}`}
          />
          <span className="text-xs text-gray-400">{connectionLabel}</span>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto p-4 pb-36 space-y-4"
      >
        {!hasContent ? (
          <EmptyState
            isAuthenticated={isConnected}
            loadingMessage={
              isConnected ? undefined : 'Connecting to qwen serve…'
            }
          />
        ) : (
          <>
            {items.map((item, index) => {
              if (item.type === 'message') {
                if (item.role === 'user') {
                  return (
                    <UserMessage
                      key={item.id}
                      content={item.content}
                      timestamp={item.timestamp}
                      onFileClick={() => {
                        // No action required.
                      }}
                    />
                  );
                }
                if (item.role === 'thinking') {
                  return (
                    <ThinkingMessage
                      key={item.id}
                      content={item.content}
                      timestamp={item.timestamp}
                      status="default"
                    />
                  );
                }
                return (
                  <AssistantMessage
                    key={item.id}
                    content={item.content}
                    timestamp={item.timestamp}
                    onFileClick={() => {
                      // No action required.
                    }}
                  />
                );
              }

              const prevType = items[index - 1]?.type;
              const nextType = items[index + 1]?.type;
              const isFirst = prevType !== 'toolCall';
              const isLast = nextType !== 'toolCall';

              const ToolCallComponent = isChromeTool(item.toolCall)
                ? ChromeToolCall
                : getToolCallComponent(item.toolCall);

              return (
                <ToolCallComponent
                  key={item.id}
                  toolCall={item.toolCall}
                  isFirst={isFirst}
                  isLast={isLast}
                />
              );
            })}

            {/* Waiting / thinking indicator before any tokens arrive. */}
            {isWaitingForResponse && (
              <WaitingMessage loadingMessage="Thinking…" />
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <InputForm
        inputText={inputText}
        inputFieldRef={inputFieldRef as React.RefObject<HTMLDivElement>}
        isStreaming={isStreaming}
        isWaitingForResponse={isWaitingForResponse}
        isComposing={isComposing}
        editMode="default"
        thinkingEnabled={false}
        activeFileName={null}
        activeSelection={null}
        skipAutoActiveContext={true}
        onInputChange={setInputText}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        onKeyDown={() => {
          // No special key handling required.
        }}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        onToggleEditMode={() => {
          // No edit mode toggle required.
        }}
        onToggleThinking={() => {
          // No thinking mode toggle required.
        }}
        onFocusActiveEditor={() => {
          // No editor focus required.
        }}
        onToggleSkipAutoActiveContext={() => {
          // No context toggle required.
        }}
        onShowCommandMenu={() => {
          // No command menu required.
        }}
        onAttachContext={() => {
          // No context attachment required.
        }}
        completionIsOpen={false}
        completionItems={[]}
        onCompletionSelect={() => {
          // No completion selection required.
        }}
        onCompletionClose={() => {
          // No completion closing required.
        }}
      />

      {/* Permission Request Drawer */}
      {pendingPermission && (
        <PermissionDrawer
          isOpen={!!pendingPermission}
          options={pendingPermission.options}
          toolCall={pendingPermission.toolCall}
          onResponse={handlePermissionResponse}
        />
      )}
    </div>
  );
};
