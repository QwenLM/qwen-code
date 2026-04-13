/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { createRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCompletionTrigger } from './useCompletionTrigger.js';

function createRect() {
  return {
    top: 12,
    left: 34,
    right: 34,
    bottom: 12,
    width: 0,
    height: 0,
    x: 34,
    y: 12,
    toJSON: () => ({}),
  } as DOMRect;
}

function setInputSelection(
  input: HTMLDivElement,
  text: string,
  cursor: number,
) {
  input.textContent = text;
  const textNode = input.firstChild;
  if (!textNode) {
    throw new Error('Expected input to contain a text node');
  }

  const range = document.createRange();
  range.setStart(textNode, cursor);
  range.setEnd(textNode, cursor);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderCompletionHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const inputRef =
    createRef<HTMLDivElement>() as unknown as React.RefObject<HTMLDivElement>;
  const getCompletionItems = vi.fn(async () => [
    {
      id: 'clear',
      label: '/clear',
      type: 'command' as const,
    },
  ]);

  let latestState: ReturnType<typeof useCompletionTrigger> | null = null;

  function Harness() {
    latestState = useCompletionTrigger(inputRef, getCompletionItems);
    return <div ref={inputRef} contentEditable="plaintext-only" />;
  }

  act(() => {
    root.render(<Harness />);
  });

  const input = inputRef.current;
  if (!input) {
    throw new Error('Expected input ref to be attached');
  }

  Object.defineProperty(input, 'getBoundingClientRect', {
    configurable: true,
    value: createRect,
  });

  return {
    container,
    root,
    input,
    getCompletionItems,
    getState: () => {
      if (!latestState) {
        throw new Error('Expected hook state to be initialized');
      }
      return latestState;
    },
  };
}

describe('useCompletionTrigger', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: createRect,
    });
  });

  afterEach(() => {
    const currentRoot = root;
    if (currentRoot) {
      act(() => {
        currentRoot.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('opens slash completion when slash is the first character', async () => {
    const rendered = renderCompletionHarness();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {
      setInputSelection(rendered.input, '/cl', 3);
      rendered.input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(rendered.getCompletionItems).toHaveBeenCalledWith('/', 'cl');
    expect(rendered.getState().isOpen).toBe(true);
  });

  it('does not open slash completion when slash is not the first character', async () => {
    const rendered = renderCompletionHarness();
    root = rendered.root;
    container = rendered.container;

    await act(async () => {
      setInputSelection(rendered.input, 'hello /cl', 9);
      rendered.input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(rendered.getCompletionItems).not.toHaveBeenCalled();
    expect(rendered.getState().isOpen).toBe(false);
  });
});
