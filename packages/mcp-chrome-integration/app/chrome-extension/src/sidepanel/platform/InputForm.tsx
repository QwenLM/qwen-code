/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * InputForm adapter for Chrome extension - wraps webui InputForm with local type handling
 */

import type { FC } from 'react';
import {
  InputForm as BaseInputForm,
  getEditModeIcon,
} from '@qwen-code/webui';
import type {
  InputFormProps as BaseInputFormProps,
  EditModeInfo,
} from '@qwen-code/webui';
import { getApprovalModeInfoFromString } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';

/**
 * Extended props that accept ApprovalModeValue and optional context usage
 */
export interface InputFormProps
  extends Omit<BaseInputFormProps, 'editModeInfo' | 'contextUsage'> {
  /** Edit mode value (local type) */
  editMode: ApprovalModeValue;
  /** Optional context usage info */
  contextUsage?: BaseInputFormProps['contextUsage'];
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
 * InputForm with ApprovalModeValue support
 */
export const InputForm: FC<InputFormProps> = ({
  editMode,
  contextUsage,
  ...rest
}) => {
  const editModeInfo = getEditModeInfo(editMode);
  const resolvedContextUsage = contextUsage ?? null;

  return (
    <BaseInputForm
      editModeInfo={editModeInfo}
      contextUsage={resolvedContextUsage}
      {...rest}
    />
  );
};
