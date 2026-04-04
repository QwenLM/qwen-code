/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { screen } from '@testing-library/react';
import type { CompletionItem } from '../../../types/completionItemTypes.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import type { InputFormProps } from './InputForm.js';

vi.mock('@qwen-code/webui', async () => {
  const { useEffect } = await import('react');

  return {
    InputForm: ({
      editModeInfo,
      completionIsOpen,
      completionItems = [],
      onCompletionSelect,
      onCompletionFill,
    }: {
      editModeInfo: { label: string; title: string; icon: unknown };
      completionIsOpen?: boolean;
      completionItems?: CompletionItem[];
      onCompletionSelect?: (item: CompletionItem) => void;
      onCompletionFill?: (item: CompletionItem) => void;
    }) => {
      useEffect(() => {
        if (!completionIsOpen || completionItems.length === 0) {
          return;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
          const firstItem = completionItems[0];
          if (!firstItem) {
            return;
          }

          if (event.key === 'Tab') {
            event.preventDefault();
            onCompletionFill?.(firstItem);
          }

          if (event.key === 'Enter') {
            event.preventDefault();
            onCompletionSelect?.(firstItem);
          }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
      }, [
        completionIsOpen,
        completionItems,
        onCompletionFill,
        onCompletionSelect,
      ]);

      return (
        <div
          data-testid="base-input"
          data-edit-label={editModeInfo?.label}
          data-edit-title={editModeInfo?.title}
          data-edit-icon={String(editModeInfo?.icon ?? '')}
        />
      );
    },
    getEditModeIcon: (type: string) => `icon:${type}`,
    PlanCompletedIcon: () => <span data-testid="plan-icon" />,
  };
});

import { InputForm } from './InputForm.js';

const baseProps: InputFormProps = {
  inputText: '',
  inputFieldRef: {
    current: document.createElement('div'),
  },
  isStreaming: false,
  isWaitingForResponse: false,
  isComposing: false,
  editMode: 'auto-edit' as ApprovalModeValue,
  thinkingEnabled: false,
  activeFileName: null,
  activeSelection: null,
  skipAutoActiveContext: false,
  contextUsage: null,
  onInputChange: vi.fn(),
  onCompositionStart: vi.fn(),
  onCompositionEnd: vi.fn(),
  onKeyDown: vi.fn(),
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  onToggleEditMode: vi.fn(),
  onToggleThinking: vi.fn(),
  onToggleSkipAutoActiveContext: vi.fn(),
  onShowCommandMenu: vi.fn(),
  onAttachContext: vi.fn(),
  completionIsOpen: false,
  completionItems: [],
  onCompletionSelect: vi.fn(),
  onCompletionClose: vi.fn(),
};

const models: ModelInfo[] = [
  { modelId: 'qwen3', name: 'Qwen 3' },
  { modelId: 'qwen2', name: 'Qwen 2', description: 'Fallback' },
];

const completionItem: CompletionItem = {
  id: 'create-issue',
  label: '/create-issue',
  type: 'command',
  value: 'create-issue',
};

describe('InputForm adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('converts editMode into editModeInfo for webui InputForm', () => {
    renderWithProviders(<InputForm {...baseProps} />);

    const baseInput = screen.getByTestId('base-input');
    expect(baseInput).toHaveAttribute('data-edit-label', 'Edit automatically');
    expect(baseInput).toHaveAttribute(
      'data-edit-title',
      'Qwen will edit files automatically. Click to switch modes.',
    );
    expect(baseInput.getAttribute('data-edit-icon')).toContain('icon:auto');
  });

  it('renders ModelSelector overlay when enabled', () => {
    renderWithProviders(
      <InputForm
        {...baseProps}
        showModelSelector
        availableModels={models}
        currentModelId="qwen3"
        onSelectModel={vi.fn()}
        onCloseModelSelector={vi.fn()}
      />,
    );

    expect(screen.getByText('Select a model')).toBeInTheDocument();
    expect(screen.getByText('Qwen 3')).toBeInTheDocument();
  });

  it('uses onCompletionFill for Tab without triggering onCompletionSelect', () => {
    const onCompletionSelect = vi.fn();
    const onCompletionFill = vi.fn();

    renderWithProviders(
      <InputForm
        {...baseProps}
        completionIsOpen={true}
        completionItems={[completionItem]}
        onCompletionSelect={onCompletionSelect}
        onCompletionFill={onCompletionFill}
      />,
    );

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onCompletionFill).toHaveBeenCalledWith(completionItem);
    expect(onCompletionSelect).not.toHaveBeenCalled();
  });

  it('keeps Enter mapped to onCompletionSelect', () => {
    const onCompletionSelect = vi.fn();
    const onCompletionFill = vi.fn();

    renderWithProviders(
      <InputForm
        {...baseProps}
        completionIsOpen={true}
        completionItems={[completionItem]}
        onCompletionSelect={onCompletionSelect}
        onCompletionFill={onCompletionFill}
      />,
    );

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onCompletionSelect).toHaveBeenCalledWith(completionItem);
    expect(onCompletionFill).not.toHaveBeenCalled();
  });
});
