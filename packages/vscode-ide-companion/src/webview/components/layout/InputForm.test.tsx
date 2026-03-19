/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { act, createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ApprovalMode } from '../../../types/acpTypes.js';
import type { CompletionItem } from '../../../types/completionItemTypes.js';
import { InputForm } from './InputForm.js';

vi.mock('@qwen-code/webui', async () => {
  const actual = await vi.importActual(
    '../../../../../webui/src/components/layout/InputForm.tsx',
  );

  return {
    InputForm: actual.InputForm,
    getEditModeIcon: actual.getEditModeIcon,
  };
});

const completionItem: CompletionItem = {
  id: 'create-issue',
  label: '/create-issue',
  type: 'command',
  value: 'create-issue',
};

function renderInputForm(props?: {
  onCompletionSelect?: (item: CompletionItem) => void;
  onCompletionFill?: (item: CompletionItem) => void;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const root = createRoot(container);
  const inputFieldRef =
    createRef<HTMLDivElement>() as unknown as React.RefObject<HTMLDivElement>;
  const onCompletionSelect = props?.onCompletionSelect ?? vi.fn();
  const onCompletionFill = props?.onCompletionFill ?? vi.fn();

  act(() => {
    root.render(
      <InputForm
        inputText=""
        inputFieldRef={inputFieldRef}
        isStreaming={false}
        isWaitingForResponse={false}
        isComposing={false}
        editMode={ApprovalMode.DEFAULT}
        thinkingEnabled={false}
        activeFileName={null}
        activeSelection={null}
        skipAutoActiveContext={false}
        contextUsage={null}
        onInputChange={vi.fn()}
        onCompositionStart={vi.fn()}
        onCompositionEnd={vi.fn()}
        onKeyDown={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onToggleEditMode={vi.fn()}
        onToggleThinking={vi.fn()}
        onToggleSkipAutoActiveContext={vi.fn()}
        onShowCommandMenu={vi.fn()}
        onAttachContext={vi.fn()}
        completionIsOpen={true}
        completionItems={[completionItem]}
        onCompletionSelect={onCompletionSelect}
        onCompletionFill={onCompletionFill}
        onCompletionClose={vi.fn()}
      />,
    );
  });

  return {
    container,
    root,
    onCompletionSelect,
    onCompletionFill,
  };
}

describe('InputForm completion keyboard handling', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('uses onCompletionFill for Tab without triggering onCompletionSelect', () => {
    const rendered = renderInputForm();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(rendered.onCompletionFill).toHaveBeenCalledWith(completionItem);
    expect(rendered.onCompletionSelect).not.toHaveBeenCalled();
  });

  it('keeps Enter mapped to onCompletionSelect', () => {
    const rendered = renderInputForm();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(rendered.onCompletionSelect).toHaveBeenCalledWith(completionItem);
    expect(rendered.onCompletionFill).not.toHaveBeenCalled();
  });
});
