/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  EditPencilIcon,
  AutoEditIcon,
  PlanModeIcon,
  CodeBracketsIcon,
  HideContextIcon,
  // ThinkingIcon,  // Temporarily disabled
  SlashCommandIcon,
  LinkIcon,
  ArrowUpIcon,
  StopIcon,
} from '../icons/index.js';
import { CompletionMenu } from '../layout/CompletionMenu.js';
import type { CompletionItem } from '../../../types/completionItemTypes.js';
import { getApprovalModeInfoFromString } from '../../../types/acpTypes.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';

interface InputFormProps {
  inputText: string;
  // Note: RefObject<T> carries nullability in its `current` property, so the
  // generic should be `HTMLDivElement` (not `HTMLDivElement | null`).
  inputFieldRef: React.RefObject<HTMLDivElement>;
  isStreaming: boolean;
  isWaitingForResponse: boolean;
  isComposing: boolean;
  editMode: ApprovalModeValue;
  thinkingEnabled: boolean;
  activeFileName: string | null;
  activeSelection: { startLine: number; endLine: number } | null;
  // Whether to auto-load the active editor selection/path into context
  skipAutoActiveContext: boolean;
  onInputChange: (text: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  onToggleEditMode: () => void;
  onToggleThinking: () => void;
  onFocusActiveEditor: () => void;
  onToggleSkipAutoActiveContext: () => void;
  onShowCommandMenu: () => void;
  onAttachContext: () => void;
  completionIsOpen: boolean;
  completionItems?: CompletionItem[];
  onCompletionSelect?: (item: CompletionItem) => void;
  onCompletionClose?: () => void;
}

// Get edit mode display info using helper function
const getEditModeInfo = (editMode: ApprovalModeValue) => {
  const info = getApprovalModeInfoFromString(editMode);

  // Map icon types to actual icons
  let icon = null;
  switch (info.iconType) {
    case 'edit':
      icon = <EditPencilIcon />;
      break;
    case 'auto':
      icon = <AutoEditIcon />;
      break;
    case 'plan':
      icon = <PlanModeIcon />;
      break;
    case 'yolo':
      icon = <AutoEditIcon />;
      break;
    default:
      icon = null;
      break;
  }

  return {
    text: info.label,
    title: info.title,
    icon,
  };
};

export const InputForm: React.FC<InputFormProps> = ({
  inputText,
  inputFieldRef,
  isStreaming,
  isWaitingForResponse,
  isComposing,
  editMode,
  // thinkingEnabled,  // Temporarily disabled
  activeFileName,
  activeSelection,
  skipAutoActiveContext,
  onInputChange,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onSubmit,
  onCancel,
  onToggleEditMode,
  // onToggleThinking,  // Temporarily disabled
  onToggleSkipAutoActiveContext,
  onShowCommandMenu,
  onAttachContext,
  completionIsOpen,
  completionItems,
  onCompletionSelect,
  onCompletionClose,
}) => {
  const editModeInfo = getEditModeInfo(editMode);
  const composerDisabled = isStreaming || isWaitingForResponse;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // ESC should cancel the current interaction (stop generation)
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    // If composing (Chinese IME input), don't process Enter key
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      // If CompletionMenu is open, let it handle Enter key
      if (completionIsOpen) {
        return;
      }
      e.preventDefault();
      onSubmit(e);
    }
    onKeyDown(e);
  };

  // Selection label like "6 lines selected"; no line numbers
  const selectedLinesCount = activeSelection
    ? Math.max(1, activeSelection.endLine - activeSelection.startLine + 1)
    : 0;
  const selectedLinesText =
    selectedLinesCount > 0
      ? `${selectedLinesCount} ${selectedLinesCount === 1 ? 'line' : 'lines'} selected`
      : '';

  return (
    <div className="p-1 px-4 pb-4 absolute bottom-0 left-0 right-0 bg-gradient-to-b from-transparent to-[var(--app-primary-background)]">
      <div className="block">
        <form className="composer-form" onSubmit={onSubmit}>
          {/* Inner background layer */}
          <div className="composer-overlay" />

          {/* Banner area */}
          <div className="input-banner" />

          <div className="relative flex z-[1]">
            {completionIsOpen &&
              completionItems &&
              completionItems.length > 0 &&
              onCompletionSelect &&
              onCompletionClose && (
                <CompletionMenu
                  items={completionItems}
                  onSelect={onCompletionSelect}
                  onClose={onCompletionClose}
                  title={undefined}
                />
              )}

            <div
              ref={inputFieldRef}
              contentEditable="plaintext-only"
              className="composer-input"
              role="textbox"
              aria-label="Message input"
              aria-multiline="true"
              data-placeholder="Ask Qwen Code …"
              // Use a data flag so CSS can show placeholder even if the browser
              // inserts an invisible <br> into contentEditable (so :empty no longer matches)
              data-empty={
                inputText.replace(/\u200B/g, '').trim().length === 0
                  ? 'true'
                  : 'false'
              }
              onInput={(e) => {
                const target = e.target as HTMLDivElement;
                // Filter out zero-width space that we use to maintain height
                const text = target.textContent?.replace(/\u200B/g, '') || '';
                onInputChange(text);
              }}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onKeyDown={handleKeyDown}
              suppressContentEditableWarning
            />
          </div>

          <div className="composer-actions">
            {/* Edit mode button */}
            <button
              type="button"
              className="btn-text-compact btn-text-compact--primary"
              title={editModeInfo.title}
              onClick={onToggleEditMode}
            >
              {editModeInfo.icon}
              {/* Let the label truncate with ellipsis; hide on very small screens */}
              <span className="hidden sm:inline">{editModeInfo.text}</span>
            </button>

            {/* Active file indicator */}
            {activeFileName && (
              <button
                type="button"
                className="btn-text-compact btn-text-compact--primary"
                title={(() => {
                  if (skipAutoActiveContext) {
                    return selectedLinesText
                      ? `Active selection will NOT be auto-loaded into context: ${selectedLinesText}`
                      : `Active file will NOT be auto-loaded into context: ${activeFileName}`;
                  }
                  return selectedLinesText
                    ? `Showing Qwen Code your current selection: ${selectedLinesText}`
                    : `Showing Qwen Code your current file: ${activeFileName}`;
                })()}
                onClick={onToggleSkipAutoActiveContext}
              >
                {skipAutoActiveContext ? (
                  <HideContextIcon />
                ) : (
                  <CodeBracketsIcon />
                )}
                {/* Truncate file path/selection; hide label on very small screens */}
                <span className="hidden sm:inline">
                  {selectedLinesText || activeFileName}
                </span>
              </button>
            )}

            {/* Spacer */}
            <div className="flex-1 min-w-0" />

            {/* @yiliang114. closed temporarily */}
            {/* Thinking button */}
            {/* <button
              type="button"
              className={`btn-icon-compact ${thinkingEnabled ? 'btn-icon-compact--active' : ''}`}
              title={thinkingEnabled ? 'Thinking on' : 'Thinking off'}
              onClick={onToggleThinking}
            >
              <ThinkingIcon enabled={thinkingEnabled} />
            </button> */}

            {/* Command button */}
            <button
              type="button"
              className="btn-icon-compact hover:text-[var(--app-primary-foreground)]"
              title="Show command menu (/)"
              onClick={onShowCommandMenu}
            >
              <SlashCommandIcon />
            </button>

            {/* Attach button */}
            <button
              type="button"
              className="btn-icon-compact hover:text-[var(--app-primary-foreground)]"
              title="Attach context (Cmd/Ctrl + /)"
              onClick={onAttachContext}
            >
              <LinkIcon />
            </button>

            {/* Send/Stop button */}
            {isStreaming || isWaitingForResponse ? (
              <button
                type="button"
                className="btn-send-compact [&>svg]:w-5 [&>svg]:h-5"
                onClick={onCancel}
                title="Stop generation"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                className="btn-send-compact [&>svg]:w-5 [&>svg]:h-5"
                disabled={composerDisabled || !inputText.trim()}
              >
                <ArrowUpIcon />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
