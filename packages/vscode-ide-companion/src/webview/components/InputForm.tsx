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
  ThinkingIcon,
  SlashCommandIcon,
  LinkIcon,
  ArrowUpIcon,
  StopIcon,
} from './icons/index.js';
import { CompletionMenu } from './ui/CompletionMenu.js';
import type { CompletionItem } from '../types/CompletionTypes.js';

type EditMode = 'ask' | 'auto' | 'plan';

interface InputFormProps {
  inputText: string;
  // Note: RefObject<T> carries nullability in its `current` property, so the
  // generic should be `HTMLDivElement` (not `HTMLDivElement | null`).
  inputFieldRef: React.RefObject<HTMLDivElement>;
  isStreaming: boolean;
  isComposing: boolean;
  editMode: EditMode;
  thinkingEnabled: boolean;
  activeFileName: string | null;
  activeSelection: { startLine: number; endLine: number } | null;
  onInputChange: (text: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  onToggleEditMode: () => void;
  onToggleThinking: () => void;
  onFocusActiveEditor: () => void;
  onShowCommandMenu: () => void;
  onAttachContext: () => void;
  completionIsOpen: boolean;
  completionItems?: CompletionItem[];
  onCompletionSelect?: (item: CompletionItem) => void;
  onCompletionClose?: () => void;
}

// Get edit mode display info
const getEditModeInfo = (editMode: EditMode) => {
  switch (editMode) {
    case 'ask':
      return {
        text: 'Ask before edits',
        title: 'Qwen will ask before each edit. Click to switch modes.',
        icon: <EditPencilIcon />,
      };
    case 'auto':
      return {
        text: 'Edit automatically',
        title: 'Qwen will edit files automatically. Click to switch modes.',
        icon: <AutoEditIcon />,
      };
    case 'plan':
      return {
        text: 'Plan mode',
        title: 'Qwen will plan before executing. Click to switch modes.',
        icon: <PlanModeIcon />,
      };
    default:
      return {
        text: 'Unknown mode',
        title: 'Unknown edit mode',
        icon: null,
      };
  }
};

export const InputForm: React.FC<InputFormProps> = ({
  inputText,
  inputFieldRef,
  isStreaming,
  isComposing,
  editMode,
  thinkingEnabled,
  activeFileName,
  activeSelection,
  onInputChange,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onSubmit,
  onCancel,
  onToggleEditMode,
  onToggleThinking,
  onFocusActiveEditor,
  onShowCommandMenu,
  onAttachContext,
  completionIsOpen,
  // Claude-style completion dropdown (optional)
  completionItems,
  onCompletionSelect,
  onCompletionClose,
}) => {
  const editModeInfo = getEditModeInfo(editMode);

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  return (
    <div
      className="p-1 px-4 pb-4"
      style={{ backgroundColor: 'var(--app-primary-background)' }}
    >
      <div className="block">
        <form className="composer-form" onSubmit={onSubmit}>
          {/* Inner background layer */}
          <div className="composer-overlay" />

          {/* Banner area */}
          <div className="input-banner" />

          {/* Input wrapper (Claude-style anchor container) */}
          <div className="relative flex z-[1]">
            {/* Claude-style anchored dropdown */}
            {completionIsOpen &&
              completionItems &&
              completionItems.length > 0 &&
              onCompletionSelect &&
              onCompletionClose && (
                // Render dropdown above the input, matching Claude Code
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
              onInput={(e) => {
                const target = e.target as HTMLDivElement;
                onInputChange(target.textContent || '');
              }}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onKeyDown={handleKeyDown}
              suppressContentEditableWarning
            />
          </div>

          {/* Actions row (compact, Claude-style) */}
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
                title={`Showing Qwen Code your current file selection: ${activeFileName}${activeSelection ? `#${activeSelection.startLine}-${activeSelection.endLine}` : ''}`}
                onClick={onFocusActiveEditor}
              >
                <CodeBracketsIcon />
                {/* Truncate file path/selection; hide label on very small screens */}
                <span className="hidden sm:inline">
                  {activeFileName}
                  {activeSelection &&
                    ` #${activeSelection.startLine}${activeSelection.startLine !== activeSelection.endLine ? `-${activeSelection.endLine}` : ''}`}
                </span>
              </button>
            )}

            {/* Spacer */}
            <div className="flex-1 min-w-0" />

            {/* Thinking button */}
            <button
              type="button"
              className={`btn-icon-compact ${thinkingEnabled ? 'btn-icon-compact--active' : ''}`}
              title={thinkingEnabled ? 'Thinking on' : 'Thinking off'}
              onClick={onToggleThinking}
            >
              <ThinkingIcon enabled={thinkingEnabled} />
            </button>

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
            {isStreaming ? (
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
                disabled={!inputText.trim()}
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
