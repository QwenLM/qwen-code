/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import type { CompletionItem } from '../../types/completionItemTypes.js';
import { useCompletionTrigger } from './useCompletionTrigger.js';
import { ModelSelector } from '../components/layout/ModelSelector.js';

const completionItems: CompletionItem[] = [
  { id: 'compact', label: '/compact', type: 'command', value: 'compact' },
];

const models: ModelInfo[] = [
  { modelId: 'model-a', name: 'Model A' },
  { modelId: 'model-b', name: 'Model B' },
];

interface HarnessProps {
  selectorOpen: boolean;
  getCompletionItems: (
    trigger: '@' | '/',
    query: string,
  ) => Promise<CompletionItem[]>;
  onSelectModel: (modelId: string) => void;
  onCloseSelector: () => void;
}

/**
 * Mirrors the App wiring: the composer input drives useCompletionTrigger,
 * the real ModelSelector mounts while "showModelSelector" is true, and
 * showModelSelector is passed to the hook as its suppression flag. The
 * invariant under test: at most one key-consuming menu may be mounted, so
 * the visible top menu always owns the keyboard.
 */
function MenusHarness({
  selectorOpen,
  getCompletionItems,
  onSelectModel,
  onCloseSelector,
}: HarnessProps) {
  const inputRef = useRef<HTMLDivElement>(null);
  const completion = useCompletionTrigger(
    inputRef,
    getCompletionItems,
    selectorOpen,
  );

  return (
    <div>
      <div
        ref={inputRef}
        data-testid="composer-input"
        contentEditable
        suppressContentEditableWarning
      />
      {completion.isOpen && <div data-testid="completion-menu" />}
      {selectorOpen && (
        <ModelSelector
          visible
          models={models}
          currentModelId={null}
          onSelectModel={onSelectModel}
          onClose={onCloseSelector}
        />
      )}
    </div>
  );
}

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
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    }),
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

function mountHarness(props: HarnessProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<MenusHarness {...props} />);
  });
  return container;
}

function rerenderHarness(props: HarnessProps) {
  act(() => {
    root?.render(<MenusHarness {...props} />);
  });
}

/** Type `text` into the composer and fire the input event the hook listens to. */
async function typeText(text: string) {
  const input = container?.querySelector(
    '[data-testid="composer-input"]',
  ) as HTMLDivElement | null;
  if (!input) {
    throw new Error('Composer input not found');
  }

  act(() => {
    input.textContent = text;
    const textNode = input.firstChild;
    if (!textNode) {
      throw new Error('Missing text node');
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode, text.length);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('completion suppression while the model selector is open', () => {
  it('never mounts the completion menu next to an open model selector', async () => {
    const getCompletionItems = vi.fn().mockResolvedValue(completionItems);
    const el = mountHarness({
      selectorOpen: true,
      getCompletionItems,
      onSelectModel: vi.fn(),
      onCloseSelector: vi.fn(),
    });

    // The probe shape from the review: with the selector open the composer
    // keeps focus, and typing '/' re-opened the completion menu underneath
    // the selector's capture-phase keydown listener. With the gate in place
    // the two menus can no longer coexist.
    await typeText('/');

    expect(el.querySelector('[data-testid="completion-menu"]')).toBeNull();
    expect(el.querySelector('.model-selector')).not.toBeNull();
    expect(getCompletionItems).not.toHaveBeenCalled();
  });

  it('leaves Enter owned by the visible menu (the selector) while suppressed', async () => {
    const onSelectModel = vi.fn();
    const onCloseSelector = vi.fn();
    mountHarness({
      selectorOpen: true,
      getCompletionItems: vi.fn().mockResolvedValue(completionItems),
      onSelectModel,
      onCloseSelector,
    });

    await typeText('/');

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Exactly one menu is mounted, so Enter selects its highlighted row —
    // no hidden-menu divergence and no unrequested completion selection.
    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith('model-a');
    expect(onCloseSelector).toHaveBeenCalledTimes(1);
  });

  it('still opens the completion menu when the selector is closed', async () => {
    const getCompletionItems = vi.fn().mockResolvedValue(completionItems);
    const el = mountHarness({
      selectorOpen: false,
      getCompletionItems,
      onSelectModel: vi.fn(),
      onCloseSelector: vi.fn(),
    });

    await typeText('/');

    expect(el.querySelector('[data-testid="completion-menu"]')).not.toBeNull();
    expect(getCompletionItems).toHaveBeenCalledWith('/', '');
  });

  it('closes an open completion menu when the selector opens', async () => {
    const props: HarnessProps = {
      selectorOpen: false,
      getCompletionItems: vi.fn().mockResolvedValue(completionItems),
      onSelectModel: vi.fn(),
      onCloseSelector: vi.fn(),
    };
    const el = mountHarness(props);

    await typeText('/');
    expect(el.querySelector('[data-testid="completion-menu"]')).not.toBeNull();

    rerenderHarness({ ...props, selectorOpen: true });

    expect(el.querySelector('[data-testid="completion-menu"]')).toBeNull();
    expect(el.querySelector('.model-selector')).not.toBeNull();
  });
});
