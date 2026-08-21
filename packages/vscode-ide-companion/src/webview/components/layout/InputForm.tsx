/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * InputForm adapter for VSCode - wraps webui InputForm with local type handling
 * This allows local ApprovalModeValue to work with webui's EditModeInfo
 */

import type { ClipboardEvent, FC, ReactNode } from 'react';
import { InputForm as BaseInputForm, getEditModeIcon } from '@qwen-code/webui';
import type {
  InputFormProps as BaseInputFormProps,
  EditModeInfo,
} from '@qwen-code/webui';
import type { CompletionItem } from '../../../types/completionItemTypes.js';
import { getApprovalModeInfoFromString } from '../../../types/acpTypes.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import { ModelSelector } from './ModelSelector.js';

/**
 * Extended props that accept ApprovalModeValue and ModelSelector
 */
export interface InputFormProps
  extends Omit<BaseInputFormProps, 'editModeInfo' | 'onCompletionFill'> {
  /** Edit mode value (local type) */
  editMode: ApprovalModeValue;
  /** Optional paste handler forwarded to the base input */
  onPaste?: (e: ClipboardEvent) => void;
  /** Optional content rendered between the input and actions */
  extraContent?: ReactNode;
  /** Completion fill callback (Tab or equivalent) */
  onCompletionFill?: (item: CompletionItem) => void;
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
 * InputForm with ApprovalModeValue and ModelSelector support
 *
 * This is an adapter that accepts the local ApprovalModeValue type
 * and converts it to webui's EditModeInfo format.
 * It also renders the ModelSelector component when needed.
 */
export const InputForm: FC<InputFormProps> = ({
  editMode,
  showModelSelector,
  availableModels,
  currentModelId,
  onSelectModel,
  onCloseModelSelector,
  ...rest
}) => {
  const editModeInfo = getEditModeInfo(editMode);

  return (
    // The wrapper doubles as the positioning context for the ModelSelector:
    // the base input form anchors to its bottom edge, and the selector grows
    // upward from it (bottom-full), so the dropdown attaches to the input
    // area instead of floating over the message list (issue #8617).
    <div className="relative">
      {showModelSelector && onSelectModel && onCloseModelSelector && (
        // z-0 keeps ModelSelector's internal z-index inside this stacking
        // context so the base input form (rendered later) stays painted
        // above the dropdown's hidden bottom section.
        <div className="absolute bottom-full left-4 right-4 mb-2 z-0 max-w-[600px] mx-auto">
          <ModelSelector
            visible={showModelSelector}
            models={availableModels ?? []}
            currentModelId={currentModelId ?? null}
            onSelectModel={onSelectModel}
            onClose={onCloseModelSelector}
          />
        </div>
      )}
      <BaseInputForm editModeInfo={editModeInfo} {...rest} />
    </div>
  );
};
