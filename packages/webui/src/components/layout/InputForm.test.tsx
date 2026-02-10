/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { InputForm } from './InputForm.js';
import type { EditModeInfo, InputFormProps } from './InputForm.js';

const render = (ui: React.ReactElement) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const editModeInfo: EditModeInfo = {
  label: 'Auto',
  title: 'Auto mode',
  icon: <span data-testid="edit-icon" />,
};

const baseProps: InputFormProps = {
  inputText: '',
  inputFieldRef: {
    current: document.createElement('div'),
  } as React.RefObject<HTMLDivElement>,
  isStreaming: false,
  isWaitingForResponse: false,
  isComposing: false,
  editModeInfo,
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

describe('InputForm', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders edit mode button with label and title', () => {
    const { container, unmount } = render(<InputForm {...baseProps} />);

    const button = container.querySelector('button[aria-label="Auto"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('title')).toBe('Auto mode');
    expect(container.querySelector('[data-testid="edit-icon"]')).not.toBeNull();

    unmount();
  });

  it('calls onInputChange when input content changes', () => {
    const onInputChange = vi.fn();
    const { container, unmount } = render(
      <InputForm {...baseProps} onInputChange={onInputChange} />,
    );

    const textbox = container.querySelector('[role="textbox"]');
    expect(textbox).not.toBeNull();
    if (textbox) {
      textbox.textContent = 'Hello';
      act(() => {
        textbox.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    expect(onInputChange).toHaveBeenCalledWith('Hello');
    unmount();
  });
});
