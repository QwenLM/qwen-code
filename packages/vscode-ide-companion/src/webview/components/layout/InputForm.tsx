/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * InputForm adapter for VSCode - wraps webui InputForm with local type handling
 * This allows local ApprovalModeValue to work with webui's EditModeInfo
 */

import type { FC } from 'react';
import { getEditModeIcon } from '@qwen-code/webui';
import type { EditModeInfo } from '@qwen-code/webui';
import { getApprovalModeInfoFromString } from '../../../types/acpTypes.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';
import type { ModelInfo } from '../../../types/acpTypes.js';
import { ModelSelector } from './ModelSelector.js';
import { ContextIndicator } from './ContextIndicator.js';
import { ImagePreview } from '../ImagePreview.js';
import type { ImageAttachment } from '../../utils/imageUtils.js';
import {
  StopIcon,
  ArrowUpIcon,
  SlashCommandIcon,
  LinkIcon,
  CodeBracketsIcon,
  HideContextIcon,
} from '../icons/index.js';

interface CompletionItem {
  id: string;
  label: string;
  description?: string;
}

/**
 * Extended props that accept ApprovalModeValue and ModelSelector
 */
export interface InputFormProps {
  /** Edit mode value (local type) */
  editMode: ApprovalModeValue;
  /** Whether to show model selector */
  showModelSelector?: boolean;
  /** Available models for selection */
  availableModels?: ModelInfo[];
  /** Current model ID */
  currentModelId?: string | null;
  /** Callback when a model is selected */
  onSelectModel?: (modelId: string) => void;
  /** Callback to close model selector */
  onCloseModelSelector?: () => void;
  /** Input text value */
  inputText: string;
  /** Whether streaming is in progress */
  isStreaming: boolean;
  /** Whether waiting for response */
  isWaitingForResponse: boolean;
  /** Whether composer is disabled */
  composerDisabled: boolean;
  /** Active file name */
  activeFileName: string | null;
  /** Active selection */
  activeSelection: { startLine: number; endLine: number } | null;
  /** Whether to skip auto active context */
  skipAutoActiveContext: boolean;
  /** Context usage info */
  contextUsage: {
    percentLeft: number;
    usedTokens: number;
    tokenLimit: number;
  } | null;
  /** Attached images */
  attachedImages?: ImageAttachment[];
  /** Input change handler */
  onInputChange: (text: string) => void;
  /** Composition start handler */
  onCompositionStart: () => void;
  /** Composition end handler */
  onCompositionEnd: () => void;
  /** Key down handler */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Submit handler */
  onSubmit: (e: React.FormEvent) => void;
  /** Cancel handler */
  onCancel: () => void;
  /** Toggle edit mode handler */
  onToggleEditMode: () => void;
  /** Toggle skip auto active context handler */
  onToggleSkipAutoActiveContext: () => void;
  /** Show command menu handler */
  onShowCommandMenu: () => void;
  /** Attach context handler */
  onAttachContext: () => void;
  /** Paste handler */
  onPaste?: (e: React.ClipboardEvent) => void;
  /** Remove image handler */
  onRemoveImage?: (id: string) => void;
  /** Whether completion menu is open */
  completionIsOpen: boolean;
  /** Completion items */
  completionItems?: CompletionItem[];
  /** Completion select handler */
  onCompletionSelect?: (item: CompletionItem) => void;
  /** Completion close handler */
  onCompletionClose?: () => void;
}

/**
 * Convert ApprovalModeValue to EditModeInfo
 */
const getEditModeInfo = (editMode: ApprovalModeValue): EditModeInfo => {
  const info = getApprovalModeInfoFromString(editMode);

  return {
    label: info.label,
    title: info.title,
    icon: info.iconType ? getEditModeIcon(info.iconType) : null,
  };
};

/**
 * InputForm with ApprovalModeValue, ModelSelector and image paste support
 */
export const InputForm: FC<InputFormProps> = ({
  editMode,
  showModelSelector,
  availableModels,
  currentModelId,
  onSelectModel,
  onCloseModelSelector,
  inputText,
  isStreaming,
  isWaitingForResponse,
  composerDisabled,
  activeFileName,
  activeSelection,
  skipAutoActiveContext,
  contextUsage,
  attachedImages = [],
  onInputChange,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onSubmit,
  onCancel,
  onToggleEditMode,
  onToggleSkipAutoActiveContext,
  onShowCommandMenu,
  onAttachContext,
  onPaste,
  onRemoveImage,
  completionIsOpen,
  completionItems,
  onCompletionSelect,
  onCompletionClose,
}) => {
  const editModeInfo = getEditModeInfo(editMode);
  const inputFieldRef = React.useRef<HTMLDivElement>(null);

  // Handle key down with enter to submit
  const handleKeyDown = (e: React.KeyboardEvent) => {
    onKeyDown(e);
  };

  // Get selected lines text
  const selectedLinesText = activeSelection
    ? activeSelection.startLine === activeSelection.endLine
      ? `Line ${activeSelection.startLine}`
      : `Lines ${activeSelection.startLine}-${activeSelection.endLine}`
    : null;

  return (
    <>
      {/* ModelSelector rendered above InputForm as a portal-like overlay */}
      {showModelSelector && onSelectModel && onCloseModelSelector && (
        <div className="fixed bottom-[120px] left-4 right-4 z-[1001] max-w-[600px] mx-auto">
          <ModelSelector
            visible={showModelSelector}
            models={availableModels ?? []}
            currentModelId={currentModelId ?? null}
            onSelectModel={onSelectModel}
            onClose={onCloseModelSelector}
          />
        </div>
      )}

      <div className="p-1 px-4 pb-4 absolute bottom-0 left-0 right-0 bg-gradient-to-b from-transparent to-[var(--app-primary-background)]">
        <div className="block">
          <form className="composer-form" onSubmit={onSubmit}>
            {/* Inner background layer */}
            <div className="composer-overlay" />

            {/* Banner area */}
            <div className="input-banner" />

            <div className="relative flex flex-col z-[1]">
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
                data-empty={
                  inputText.replace(/\u200B/g, '').trim().length === 0
                    ? 'true'
                    : 'false'
                }
                onInput={(e) => {
                  const target = e.target as HTMLDivElement;
                  const text = target.textContent?.replace(/\u200B/g, '') || '';
                  onInputChange(text);
                }}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd}
                onKeyDown={handleKeyDown}
                onPaste={onPaste}
                suppressContentEditableWarning
              />

              {/* Image Preview area - shown at the bottom inside the input box */}
              {attachedImages.length > 0 && onRemoveImage && (
                <ImagePreview images={attachedImages} onRemove={onRemoveImage} />
              )}
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
                <span className="hidden sm:inline">{editModeInfo.label}</span>
              </button>

              {/* Active file indicator */}
              {activeFileName && (
                <button
                  type="button"
                  className="btn-text-compact btn-text-compact--primary"
                  title={() => {
                    if (skipAutoActiveContext) {
                      return selectedLinesText
                        ? `Active selection will NOT be auto-loaded into context: ${selectedLinesText}`
                        : `Active file will NOT be auto-loaded into context: ${activeFileName}`;
                    }
                    return selectedLinesText
                      ? `Showing Qwen Code your current selection: ${selectedLinesText}`
                      : `Showing Qwen Code your current file: ${activeFileName}`;
                  }}
                  onClick={onToggleSkipAutoActiveContext}
                >
                  {skipAutoActiveContext ? (
                    <HideContextIcon />
                  ) : (
                    <CodeBracketsIcon />
                  )}
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
    </>
  );
};

// Import React for useRef
import React from 'react';

// CompletionMenu component (simplified)
interface CompletionMenuProps {
  items: CompletionItem[];
  onSelect: (item: CompletionItem) => void;
  onClose: () => void;
  title?: string;
}

const CompletionMenu: FC<CompletionMenuProps> = ({
  items,
  onSelect,
  onClose,
  title,
}) => {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-[var(--app-input-background)] border border-[var(--app-input-border)] rounded-md shadow-lg z-50 max-h-60 overflow-auto">
      {title && (
        <div className="px-3 py-2 text-xs text-[var(--app-secondary-foreground)] border-b border-[var(--app-input-border)]">
          {title}
        </div>
      )}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="w-full px-3 py-2 text-left hover:bg-[var(--app-hover-background)] text-[var(--app-primary-foreground)]"
          onClick={() => onSelect(item)}
        >
          <div className="font-medium">{item.label}</div>
          {item.description && (
            <div className="text-xs text-[var(--app-secondary-foreground)]">
              {item.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
};
