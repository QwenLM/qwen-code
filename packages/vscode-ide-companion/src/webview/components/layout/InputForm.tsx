/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * InputForm adapter for VSCode - wraps webui InputForm with local type handling
 * This allows local ApprovalModeValue to work with webui's EditModeInfo
 */

import type { ClipboardEvent, FC, ReactNode } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
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
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [formHeight, setFormHeight] = useState(0);

  // The base form's root is `absolute bottom-0 left-0 right-0` and out of
  // flow, so the wrapper below would collapse to zero height and any
  // `bottom-full` dropdown would anchor at the viewport bottom, behind the
  // opaque form (issue #8617). Measure the form and give the wrapper its
  // height so `bottom-full` clears the form's top edge.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === 'undefined') {
      return;
    }

    // Find the wrapper child that contains the base form (the webui
    // InputForm root) so the dropdown tracks the form's real height.
    const form = wrapper.querySelector('form.composer-form');
    let node: HTMLElement | null = form instanceof HTMLElement ? form : null;
    while (node && node.parentElement !== wrapper) {
      node = node.parentElement;
    }
    if (!node) {
      return;
    }
    const formRoot = node;

    const measure = () => {
      setFormHeight(formRoot.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(formRoot);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    // Positioning context for the ModelSelector. The base form's root is
    // `absolute bottom-0 left-0 right-0` and out of flow (see
    // packages/webui/src/components/layout/InputForm.tsx), so left alone
    // this wrapper would collapse to zero height and `bottom-full` would
    // anchor the dropdown at the viewport bottom, behind the opaque form
    // (issue #8617). The effect above sizes this wrapper to the form's
    // measured height, so `bottom-full` anchors the dropdown's bottom edge
    // to the form's top edge and the dropdown grows upward over the message
    // list instead of being hidden behind the form. `flex-shrink-0` keeps
    // the flex parent from shrinking this wrapper below the measured form
    // height in short webviews — an explicit height alone does not prevent
    // flex shrinking, and a shrunken wrapper would slide the `bottom-full`
    // anchor back behind the opaque form (#8617-style occlusion).
    <div
      ref={wrapperRef}
      className="relative flex-shrink-0"
      style={formHeight > 0 ? { height: `${formHeight}px` } : undefined}
    >
      {showModelSelector && onSelectModel && onCloseModelSelector && (
        // z-0 keeps ModelSelector's internal z-index (z-[1000]) inside this
        // stacking context so the dropdown stays painted below the fixed
        // overlays (PermissionDrawer / AskUserQuestionDialog /
        // AccountInfoDialog) rendered by App.tsx; App closes the selector
        // when an overlay takes over and never opens it underneath one.
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
