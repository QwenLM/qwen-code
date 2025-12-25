/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { ChevronDownIcon, PlusIcon } from '../icons/index.js';

interface ChatHeaderProps {
  currentSessionTitle: string;
  onLoadSessions: () => void;
  onNewSession: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  currentSessionTitle,
  onLoadSessions,
  onNewSession,
}) => (
  <div
    className="chat-header flex items-center select-none w-full border-b border-[var(--app-primary-border-color)] bg-[var(--app-header-background)] py-1.5 px-2.5"
    style={{ borderBottom: '1px solid var(--app-primary-border-color)' }}
  >
    <button
      className="flex items-center gap-1.5 py-0.5 px-2 bg-transparent border-none rounded cursor-pointer outline-none min-w-0 max-w-[300px] overflow-hidden text-[var(--vscode-chat-font-size,13px)] font-[var(--vscode-chat-font-family)] hover:bg-[var(--app-ghost-button-hover-background)] focus:bg-[var(--app-ghost-button-hover-background)]"
      onClick={onLoadSessions}
      title="Past conversations"
    >
      <span className="whitespace-nowrap overflow-hidden text-ellipsis min-w-0 font-medium">
        {currentSessionTitle}
      </span>
      <ChevronDownIcon className="w-4 h-4 flex-shrink-0" />
    </button>

    <div className="flex-1 min-w-1"></div>

    <button
      className="flex items-center justify-center p-1 bg-transparent border-none rounded cursor-pointer outline-none hover:bg-[var(--app-ghost-button-hover-background)]"
      onClick={onNewSession}
      title="New Session"
      style={{ padding: '4px' }}
    >
      <PlusIcon className="w-4 h-4" />
    </button>
  </div>
);
