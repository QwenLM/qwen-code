/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * InputForm component - Main chat input with toolbar
 * Platform-agnostic version with configurable edit modes
 */

import type { FC } from 'react';
import type { ReactNode } from 'react';
import {
  EditPencilIcon,
  AutoEditIcon,
  PlanModeIcon,
} from '../icons/EditIcons.js';
import { CodeBracketsIcon, HideContextIcon } from '../icons/EditIcons.js';
import { SlashCommandIcon, LinkIcon } from '../icons/EditIcons.js';
import { ArrowUpIcon } from '../icons/NavigationIcons.js';
import { StopIcon } from '../icons/StopIcon.js';
import { CompletionMenu } from './CompletionMenu.js';
import { ContextIndicator } from './ContextIndicator.js';
import type { CompletionItem } from '../../types/completion.js';
import type { ContextUsage } from './ContextIndicator.js';

/**
 * Edit mode display information
 */
export interface EditModeInfo {
  /** Display label */
  label: string;
  /** Tooltip text */
  title: string;
  /** Icon to display */
  icon: ReactNode;
}

/**
 * Built-in icon types for edit modes
 */
export type EditModeIconType = 'edit' | 'auto' | 'plan' | 'yolo';

/**
 * Get icon component for edit mode type
 */
export const getEditModeIcon = (iconType: EditModeIconType): ReactNode => {
  switch (iconType) {
    case 'edit':
      return <EditPencilIcon />;
    case 'auto':
    case 'yolo':
      return <AutoEditIcon />;
    case 'plan':
      return <PlanModeIcon />;
    default:
      return null;
  }
};

/**
 * Props for InputForm component
 */
export interface InputFormProps {
  /** Current input text */
  inputText: string;
  /** Ref for the input field */
  inputFieldRef: React.RefObject<HTMLDivElement>;
  /** Whether AI is currently generating */
  isStreaming: boolean;
  /** Whether waiting for response */
  isWaitingForResponse: boolean;
  /** Whether IME composition is in progress */
  isComposing: boolean;
  /** Edit mode display information */
  editModeInfo: EditModeInfo;
  /** Whether thinking mode is enabled */
  thinkingEnabled: boolean;
  /** Active file name (from editor) */
  activeFileName: string | null;
  /** Active selection range */
  activeSelection: { startLine: number; endLine: number } | null;
  /** Whether to skip auto-loading active context */
  skipAutoActiveContext: boolean;
  /** Context usage information */
  contextUsage: ContextUsage | null;
  /** Input change callback */
  onInputChange: (text: string) => void;
  /** Composition start callback */
  onCompositionStart: () => void;
  /** Composition end callback */
  onCompositionEnd: () => void;
  /** Key down callback */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Submit callback */
  onSubmit: (e: React.FormEvent) => void;
  /** Cancel callback */
  onCancel: () => void;
  /** Toggle edit mode callback */
  onToggleEditMode: () => void;
  /** Toggle thinking callback */
  onToggleThinking: () => void;
  /** Focus active editor callback */
  onFocusActiveEditor?: () => void;
  /** Toggle skip auto context callback */
  onToggleSkipAutoActiveContext: () => void;
  /** Show command menu callback */
  onShowCommandMenu: () => void;
  /** Attach context callback */
  onAttachContext: () => void;
  /** Whether completion menu is open */
  completionIsOpen: boolean;
  /** Completion items */
  completionItems?: CompletionItem[];
  /** Completion select callback */
  onCompletionSelect?: (item: CompletionItem) => void;
  /** Completion close callback */
  onCompletionClose?: () => void;
  /** Placeholder text */
  placeholder?: string;
}

/**
 * InputForm component
 *
 * Features:
 * - ContentEditable input with placeholder
 * - Edit mode toggle with customizable icons
 * - Active file/selection indicator
 * - Context usage display
 * - Command and attach buttons
 * - Send/Stop button based on state
 * - Completion menu integration
 *
 * @example
 * ```tsx
 * <InputForm
 *   inputText={text}
 *   inputFieldRef={inputRef}
 *   isStreaming={false}
 *   isWaitingForResponse={false}
 *   isComposing={false}
 *   editModeInfo={{ label: 'Auto', title: 'Auto mode', icon: <AutoEditIcon /> }}
 *   // ... other props
 * />
 * ```
 */
export const InputForm: FC<InputFormProps> = ({
  inputText,
  inputFieldRef,
  isStreaming,
  isWaitingForResponse,
  isComposing,
  editModeInfo,
  // thinkingEnabled,  // Temporarily disabled
  activeFileName,
  activeSelection,
  skipAutoActiveContext,
  contextUsage,
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
  placeholder = 'Ask Qwen Code …',
}) => {
  const composerDisabled = isStreaming || isWaitingForResponse;
  const completionItemsResolved = completionItems ?? [];
  const completionActive =
    completionIsOpen &&
    completionItemsResolved.length > 0 &&
    !!onCompletionSelect &&
    !!onCompletionClose;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Let the completion menu handle Escape when it's active.
    if (completionActive && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCompletionClose?.();
      return;
    }
    // ESC should cancel the current interaction (stop generation)
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    // If composing (Chinese IME input), don't process Enter key
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      // If CompletionMenu is open, let it handle Enter key
      if (completionActive) {
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

  // Pre-compute active file title for accessibility
  const activeFileTitle = activeFileName
    ? skipAutoActiveContext
      ? selectedLinesText
        ? `Active selection will NOT be auto-loaded into context: ${selectedLinesText}`
        : `Active file will NOT be auto-loaded into context: ${activeFileName}`
      : selectedLinesText
        ? `Showing your current selection: ${selectedLinesText}`
        : `Showing your current file: ${activeFileName}`
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
            {completionActive && onCompletionSelect && onCompletionClose && (
              <CompletionMenu
                items={completionItemsResolved}
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
              data-placeholder={placeholder}
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
              aria-label={editModeInfo.label}
              onClick={onToggleEditMode}
            >
              {editModeInfo.icon}
              {/* Let the label truncate with ellipsis; hide on very small screens */}
              <span className="hidden sm:inline">{editModeInfo.label}</span>
            </button>

            {/* Active file indicator */}
            {activeFileName && (
              <button
                type="button"
                className="btn-text-compact btn-text-compact--primary"
                title={activeFileTitle}
                aria-label={activeFileTitle}
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

            {/* Context usage indicator */}
            <ContextIndicator contextUsage={contextUsage} />

            {/* Command button */}
            <button
              type="button"
              className="btn-icon-compact hover:text-[var(--app-primary-foreground)]"
              title="Show command menu (/)"
              aria-label="Show command menu"
              onClick={onShowCommandMenu}
            >
              <SlashCommandIcon />
            </button>

            {/* Attach button */}
            <button
              type="button"
              className="btn-icon-compact hover:text-[var(--app-primary-foreground)]"
              title="Attach context (Cmd/Ctrl + /)"
              aria-label="Attach context"
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
                aria-label="Stop generation"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                className="btn-send-compact [&>svg]:w-5 [&>svg]:h-5"
                disabled={composerDisabled || !inputText.trim()}
                aria-label="Send message"
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
