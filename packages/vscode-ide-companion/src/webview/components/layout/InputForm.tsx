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
  /**
   * Reports the open model-selector dropdown's measured height so the chat
   * viewport can reserve bottom scroll clearance for it (issue #8617: the
   * last message must stay revealable while the dropdown is open).
   */
  onModelSelectorClearance?: (heightPx: number) => void;
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
  onModelSelectorClearance,
  ...rest
}) => {
  const editModeInfo = getEditModeInfo(editMode);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
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

  // While the selector is open, report the dropdown's measured height so
  // the chat viewport can reserve bottom scroll clearance for it — the
  // dropdown paints over the messages viewport, and without clearance the
  // last message's tail cannot be scrolled into view while the dropdown is
  // open (issue #8617).
  useLayoutEffect(() => {
    const dropdown = dropdownRef.current;
    if (
      !showModelSelector ||
      !dropdown ||
      !onModelSelectorClearance ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }
    const measure = () => {
      onModelSelectorClearance(dropdown.getBoundingClientRect().height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dropdown);
    return () => {
      observer.disconnect();
    };
  }, [showModelSelector, onModelSelectorClearance]);

  return (
    // Positioning context for the ModelSelector. The base form's root is
    // `absolute bottom-0 left-0 right-0` and out of flow (see
    // packages/webui/src/components/layout/InputForm.tsx), so left alone
    // this wrapper would collapse to zero height and the dropdown would
    // anchor at the viewport bottom, behind the opaque form (issue #8617).
    // The effect above sizes this wrapper to the form's measured height so
    // the flex layout reserves the form's space in the chat column.
    //
    // The wrapper is deliberately NOT flex-shrink-0: when the form grows
    // taller than the webview (collapsed bottom panel, image previews,
    // multi-line draft), this child must give way so the form's bottom
    // edge stays pinned to the viewport bottom and its action row remains
    // reachable — a rigid wrapper pushes the action row below the viewport
    // with no scroll recovery (body overflow:hidden). The dropdown anchor
    // below uses the measured form height directly instead of this
    // wrapper's rendered height, so shrinking here cannot slide the anchor
    // back behind the opaque form.
    <div
      ref={wrapperRef}
      className="relative"
      style={formHeight > 0 ? { height: `${formHeight}px` } : undefined}
    >
      {showModelSelector && onSelectModel && onCloseModelSelector && (
        // z-30 places this wrapper's stacking context above the local-message
        // notices (z-20, see App.tsx) so the interactive dropdown rows paint
        // over any coexisting notice, but still below the fixed overlays
        // (z-[999]/z-[1000]: PermissionDrawer / AskUserQuestionDialog /
        // AccountInfoDialog / SessionSelector). It also keeps ModelSelector's
        // internal z-index (z-[1000]) inside this stacking context so the
        // dropdown never escapes above those overlays; App closes the selector
        // when an overlay takes over and never opens it underneath one.
        //
        // The anchor is the measured form height, not bottom-full (== this
        // wrapper's rendered height): the form's bottom edge is pinned to
        // this wrapper's bottom edge, so `formHeight` above the wrapper
        // bottom is always the form's top edge — even when the wrapper
        // shrinks in a short webview (issue #8617, both directions).
        // bottom-full stays as the pre-measurement fallback.
        <div
          ref={dropdownRef}
          style={formHeight > 0 ? { bottom: `${formHeight}px` } : undefined}
          className="absolute bottom-full left-4 right-4 mb-2 z-30 max-w-[600px] mx-auto"
        >
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
