/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../test-utils/render.js';
import type { ApprovalModeValue } from '../../../types/approvalModeValueTypes.js';
import type { ModelInfo } from '../../../types/acpTypes.js';
import type { InputFormProps } from './InputForm.js';

vi.mock('@qwen-code/webui', () => ({
  InputForm: ({
    editModeInfo,
  }: {
    editModeInfo: { label: string; title: string; icon: unknown };
  }) => (
    <div
      data-testid="base-input"
      data-edit-label={editModeInfo?.label}
      data-edit-title={editModeInfo?.title}
      data-edit-icon={String(editModeInfo?.icon ?? '')}
    />
  ),
  getEditModeIcon: (type: string) => `icon:${type}`,
  PlanCompletedIcon: () => <span data-testid="plan-icon" />,
}));

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
};

const models: ModelInfo[] = [
  { modelId: 'qwen3', name: 'Qwen 3' },
  { modelId: 'qwen2', name: 'Qwen 2', description: 'Fallback' },
];

describe('InputForm adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.HTMLElement.prototype.scrollIntoView) {
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
  });

  it('converts editMode into editModeInfo for webui InputForm', () => {
    render(<InputForm {...baseProps} />);

    const baseInput = screen.getByTestId('base-input');
    expect(baseInput).toHaveAttribute('data-edit-label', 'Edit automatically');
    expect(baseInput).toHaveAttribute(
      'data-edit-title',
      'Qwen will edit files automatically. Click to switch modes.',
    );
    expect(baseInput.getAttribute('data-edit-icon')).toContain('icon:auto');
  });

  it('renders ModelSelector overlay when enabled', () => {
    render(
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
});
