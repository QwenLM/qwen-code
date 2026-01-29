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

/**
 * Extended props that accept ApprovalModeValue
 */
export interface InputFormProps
  extends Omit<BaseInputFormProps, 'editModeInfo'> {
  /** Edit mode value (local type) */
  editMode: ApprovalModeValue;
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
 *
 * This is an adapter that accepts the local ApprovalModeValue type
 * and converts it to webui's EditModeInfo format.
 */
export const InputForm: FC<InputFormProps> = ({ editMode, ...rest }) => {
  const editModeInfo = getEditModeInfo(editMode);

  return <BaseInputForm editModeInfo={editModeInfo} {...rest} />;
};
