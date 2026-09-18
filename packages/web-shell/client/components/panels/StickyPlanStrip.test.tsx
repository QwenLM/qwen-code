// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { STICKY_TODO_MAX_VISIBLE_ITEMS } from '../../utils/todos';
import { StickyPlanStrip } from './StickyPlanStrip';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
  mounted.push({ root, container });
  return container;
}

const todo = (id: string, status: TodoItem['status']): TodoItem => ({
  id,
  status,
  content: `Step ${id}`,
});

describe('StickyPlanStrip', () => {
  it('renders nothing without todos', () => {
    const container = render(
      <StickyPlanStrip
        todos={[]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(container.textContent).toBe('');
  });

  it('orders open items first and caps the visible list', () => {
    const todos = [
      todo('1', 'completed'),
      todo('2', 'pending'),
      todo('3', 'in_progress'),
      todo('4', 'pending'),
      todo('5', 'pending'),
      todo('6', 'pending'),
      todo('7', 'pending'),
    ];
    const container = render(
      <StickyPlanStrip
        todos={todos}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('Step 1 / 7');
    expect(container.textContent).toContain('Step 3');
    expect(container.textContent).toContain(
      `... ${todos.length - STICKY_TODO_MAX_VISIBLE_ITEMS} more`,
    );
    expect(container.querySelectorAll('li')).toHaveLength(
      STICKY_TODO_MAX_VISIBLE_ITEMS + 1,
    );
  });

  it('hides the list while collapsed and toggles on click', () => {
    const onToggleCollapsed = vi.fn();
    const container = render(
      <StickyPlanStrip
        todos={[todo('1', 'in_progress')]}
        collapsed
        onToggleCollapsed={onToggleCollapsed}
      />,
    );

    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(container.textContent).toContain('Step 1 / 1');

    const button = container.querySelector(
      'button[aria-label="Expand task list"]',
    );
    act(() => (button as HTMLButtonElement).click());
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('opens the plan surface from the progress control', () => {
    const onOpen = vi.fn();
    const container = render(
      <StickyPlanStrip
        todos={[todo('1', 'in_progress')]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onOpen={onOpen}
      />,
    );

    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.includes('Step 1 / 1'),
    );
    act(() => (button as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
