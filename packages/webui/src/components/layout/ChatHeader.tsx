/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * ChatHeader component - Header for chat interface
 * Displays current session title with navigation controls
 */

import type { FC } from 'react';
import { ChevronDownIcon } from '../icons/NavigationIcons.js';
import { PlusIcon } from '../icons/NavigationIcons.js';

/**
 * Props for ChatHeader component
 */
export interface ChatHeaderProps {
  /** Current session title to display */
  currentSessionTitle: string;
  /** Callback when user clicks to load session list */
  onLoadSessions: () => void;
  /** Callback when user clicks to create new session */
  onNewSession: () => void;
}

/**
 * ChatHeader component
 *
 * Features:
 * - Displays current session title with dropdown indicator
 * - Button to view past conversations
 * - Button to create new session
 *
 * @example
 * ```tsx
 * <ChatHeader
 *   currentSessionTitle="My Chat"
 *   onLoadSessions={() => console.log('Load sessions')}
 *   onNewSession={() => console.log('New session')}
 * />
 * ```
 */
export const ChatHeader: FC<ChatHeaderProps> = ({
  currentSessionTitle,
  onLoadSessions,
  onNewSession,
}) => (
  <div
    className="chat-header flex items-center select-none w-full border-b border-[var(--app-primary-border-color)] bg-[var(--app-header-background)] py-1.5 px-2.5"
    style={{ borderBottom: '1px solid var(--app-primary-border-color)' }}
  >
    <button
      type="button"
      className="flex items-center gap-1.5 py-0.5 px-2 bg-transparent border-none rounded cursor-pointer outline-none min-w-0 max-w-[300px] overflow-hidden text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)] text-[var(--app-primary-foreground)] hover:bg-[var(--app-ghost-button-hover-background)] focus:bg-[var(--app-ghost-button-hover-background)]"
      onClick={onLoadSessions}
      title="Past conversations"
    >
      <span className="whitespace-nowrap overflow-hidden text-ellipsis min-w-0 font-medium text-[var(--app-primary-foreground)]">
        {currentSessionTitle}
      </span>
      <ChevronDownIcon className="w-4 h-4 flex-shrink-0 text-[var(--app-primary-foreground)]" />
    </button>

    <div className="flex-1 min-w-0" />

    <button
      type="button"
      className="flex items-center justify-center p-1 bg-transparent border-none rounded cursor-pointer outline-none text-[var(--app-primary-foreground)] hover:bg-[var(--app-ghost-button-hover-background)]"
      onClick={onNewSession}
      title="New Session"
      aria-label="New session"
      style={{ padding: '4px' }}
    >
      <PlusIcon className="w-4 h-4 text-[var(--app-primary-foreground)]" />
    </button>
  </div>
);
