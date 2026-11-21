// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { TodoPanel } from './TodoPanel';
import styles from './TodoPanel.module.css';

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

describe('TodoPanel bottom status items', () => {
  it('opens plan execution from the progress control', () => {
    const onOpen = vi.fn();
    const container = render(
      <TodoPanel todos={[todo('1', 'in_progress')]} onOpen={onOpen} />,
    );

    const button = container.querySelector('button[aria-label="Step 1 / 1"]');
    act(() => (button as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders status items beside todo progress with a separator', () => {
    const onClick = vi.fn();
    const container = render(
      <TodoPanel
        todos={[todo('1', 'in_progress'), todo('2', 'pending')]}
        statusItems={[
          {
            id: 'changed-files',
            label: '1 file changed',
            title: 'Open changed files',
            onClick,
          },
        ]}
      />,
    );

    expect(container.textContent).toContain('Step 1 / 2');
    expect(container.textContent).toContain('·');
    const button = container.querySelector(
      'button[title="Open changed files"]',
    );
    expect(button?.textContent).toBe('1 file changed');
    act(() => {
      (button as HTMLButtonElement).click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('can render status-only content without todo progress or detail tooltip', () => {
    const container = render(
      <TodoPanel
        todos={[]}
        statusItems={[
          {
            id: 'changed-files',
            label: '2 files changed',
            ariaLabel: 'Open changed files',
          },
        ]}
      />,
    );

    expect(container.textContent).toBe('2 files changed');
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(
      'Open changed files',
    );
    expect(container.querySelector('div[aria-label="Step 0 / 0"]')).toBeNull();
  });
});

describe('TodoPanel detail tooltip', () => {
  it('opens the plan execution from the detail tooltip when onOpen is provided', () => {
    const onOpen = vi.fn();
    const container = render(
      <TodoPanel
        todos={[todo('1', 'in_progress'), todo('2', 'pending')]}
        onOpen={onOpen}
      />,
    );

    const detail = container.querySelector('div[role="button"]') as HTMLElement;
    expect(detail).not.toBeNull();
    expect(detail.getAttribute('tabindex')).toBe('0');
    act(() => detail.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('activates the detail tooltip with Enter and Space', () => {
    const onOpen = vi.fn();
    const container = render(
      <TodoPanel todos={[todo('1', 'pending')]} onOpen={onOpen} />,
    );

    const detail = container.querySelector('div[role="button"]') as HTMLElement;
    act(() => detail.focus());
    act(() => {
      detail.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => {
      detail.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('shows the pointer affordance as a module class only when clickable', () => {
    const container = render(
      <TodoPanel todos={[todo('1', 'pending')]} onOpen={vi.fn()} />,
    );

    const detail = container.querySelector('div[role="button"]') as HTMLElement;
    expect(detail.classList.contains(styles.detailClickable)).toBe(true);
  });

  it('keeps the detail tooltip inert when onOpen is not provided', () => {
    const container = render(<TodoPanel todos={[todo('1', 'pending')]} />);

    const detail = container.querySelector('[role="tooltip"]') as HTMLElement;
    expect(detail).not.toBeNull();
    expect(detail.classList.contains(styles.detailClickable)).toBe(false);
    expect(detail.getAttribute('tabindex')).toBeNull();
    expect(detail.getAttribute('aria-label')).toBeNull();
    act(() => detail.click());
  });

  it('ignores the click that ends a text selection', () => {
    const onOpen = vi.fn();
    const container = render(
      <TodoPanel
        todos={[todo('1', 'in_progress'), todo('2', 'pending')]}
        onOpen={onOpen}
      />,
    );

    const detail = container.querySelector('div[role="button"]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(detail);
    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    selection!.removeAllRanges();
    selection!.addRange(range);
    act(() => detail.click());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores the repeat click of a double-click', () => {
    const onOpen = vi.fn();
    const container = render(
      <TodoPanel todos={[todo('1', 'pending')]} onOpen={onOpen} />,
    );

    const detail = container.querySelector('div[role="button"]') as HTMLElement;
    act(() => {
      detail.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 2,
        }),
      );
    });
    expect(onOpen).not.toHaveBeenCalled();
  });
});
