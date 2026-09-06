/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SuggestionsDisplay, type Suggestion } from './SuggestionsDisplay.js';
import { RowMouseController } from './shared/RowMouseController.js';
import { CompletionCategoryMouseController } from './CompletionCategoryMouseController.js';

vi.mock('./shared/RowMouseController.js', () => ({
  RowMouseController: vi.fn(() => null),
}));
vi.mock('./CompletionCategoryMouseController.js', () => ({
  CompletionCategoryMouseController: vi.fn(() => null),
}));

const suggestions: Suggestion[] = [
  { label: 'help', value: 'help' },
  { label: 'clear', value: 'clear' },
  { label: 'model', value: 'model' },
];

describe('SuggestionsDisplay mouse wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts RowMouseController with the scroll offset + callbacks when enabled', () => {
    const onHoverIndex = vi.fn();
    const onSelectIndex = vi.fn();
    render(
      <SuggestionsDisplay
        suggestions={suggestions}
        activeIndex={0}
        isLoading={false}
        width={60}
        scrollOffset={2}
        userInput=""
        mode="slash"
        mouseEnabled
        onHoverIndex={onHoverIndex}
        onSelectIndex={onSelectIndex}
      />,
    );
    expect(RowMouseController).toHaveBeenCalled();
    const props = vi.mocked(RowMouseController).mock.calls[0][0];
    // scrollOffset is the index of the first visible suggestion (startIndex),
    // so RowMouseController maps visible position → original suggestion index.
    expect(props.scrollOffset).toBe(2);
    expect(props.onHoverIndex).toBe(onHoverIndex);
    expect(props.onSelectIndex).toBe(onSelectIndex);
  });

  it('does not mount RowMouseController when mouse is disabled', () => {
    render(
      <SuggestionsDisplay
        suggestions={suggestions}
        activeIndex={0}
        isLoading={false}
        width={60}
        scrollOffset={0}
        userInput=""
        mode="slash"
        mouseEnabled={false}
        onHoverIndex={vi.fn()}
        onSelectIndex={vi.fn()}
      />,
    );
    expect(RowMouseController).not.toHaveBeenCalled();
  });

  it('does not mount RowMouseController when the callbacks are absent', () => {
    render(
      <SuggestionsDisplay
        suggestions={suggestions}
        activeIndex={0}
        isLoading={false}
        width={60}
        scrollOffset={0}
        userInput=""
        mode="slash"
        mouseEnabled
      />,
    );
    expect(RowMouseController).not.toHaveBeenCalled();
  });

  it('mounts the category controller with exact tabs when enabled', () => {
    const onSelectCategory = vi.fn();
    render(
      <SuggestionsDisplay
        suggestions={[
          { label: 'a.ts', value: 'a.ts', category: 'file' },
          { label: 'Session', value: 'session:1', category: 'session' },
        ]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        mouseEnabled
        activeCategory="all"
        availableCategories={['all', 'file', 'session']}
        onSelectCategory={onSelectCategory}
      />,
    );

    expect(CompletionCategoryMouseController).toHaveBeenCalled();
    const props = vi.mocked(CompletionCategoryMouseController).mock.calls[0][0];
    expect(props.categories).toEqual(['all', 'file', 'session']);
    expect(props.containerRef.current).not.toBeNull();
    expect(props.categoryRefs.current).toHaveLength(props.categories.length);
    expect(
      props.categoryRefs.current.map((node) => {
        const textElement = node?.childNodes[0];
        if (!textElement || textElement.nodeName === '#text') return '';

        return textElement.childNodes
          .map((child) => (child.nodeName === '#text' ? child.nodeValue : ''))
          .join('')
          .trim();
      }),
    ).toEqual(['All', 'Files', 'Sessions']);
    expect(props.onSelectCategory).toBe(onSelectCategory);
  });

  it('does not mount the category controller when mouse is disabled', () => {
    render(
      <SuggestionsDisplay
        suggestions={[
          { label: 'a.ts', value: 'a.ts', category: 'file' },
          { label: 'Session', value: 'session:1', category: 'session' },
        ]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        mouseEnabled={false}
        activeCategory="all"
        availableCategories={['all', 'file', 'session']}
        onSelectCategory={vi.fn()}
      />,
    );

    expect(CompletionCategoryMouseController).not.toHaveBeenCalled();
  });

  it('does not mount the category controller without a selection callback', () => {
    render(
      <SuggestionsDisplay
        suggestions={[
          { label: 'a.ts', value: 'a.ts', category: 'file' },
          { label: 'Session', value: 'session:1', category: 'session' },
        ]}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        mouseEnabled
        activeCategory="all"
        availableCategories={['all', 'file', 'session']}
      />,
    );

    expect(CompletionCategoryMouseController).not.toHaveBeenCalled();
  });

  it('does not mount the category controller when the tab bar is hidden', () => {
    render(
      <SuggestionsDisplay
        suggestions={suggestions}
        activeIndex={0}
        isLoading={false}
        width={80}
        scrollOffset={0}
        userInput=""
        mode="reverse"
        mouseEnabled
        activeCategory="all"
        availableCategories={['all', 'file']}
        onSelectCategory={vi.fn()}
      />,
    );

    expect(CompletionCategoryMouseController).not.toHaveBeenCalled();
  });
});
