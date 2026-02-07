/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * InputForm adapter for VSCode - wraps webui InputForm with local type handling
 * This allows local ApprovalModeValue to work with webui's EditModeInfo
 */

import type { FC } from 'react';
import { InputForm as BaseInputForm, getEditModeIcon } from '@qwen-code/webui';
import type {
  InputFormProps as BaseInputFormProps,
  EditModeInfo,
} from '@qwen-code/webui';
import { getApprovalModeInfoFromString } from '../../../types/acpTypes.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';
import type { ModelInfo } from '../../../types/acpTypes.js';
import { ModelSelector } from './ModelSelector.js';

/**
 * Extended props that accept ApprovalModeValue and ModelSelector
 */
export interface InputFormProps
  extends Omit<BaseInputFormProps, 'editModeInfo'> {
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
      <BaseInputForm editModeInfo={editModeInfo} {...rest} />
    </>
  );
};
