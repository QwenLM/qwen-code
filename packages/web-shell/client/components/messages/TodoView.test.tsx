// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { TodoItem } from '../../adapters/types';
import { todoStateKey, type TodoDetail } from '../../utils/todos';

// TodoFullList reads TodoDetailContext from App; mock it so the unit test
// doesn't pull the whole application graph and can inject its own detail map.
vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return { TodoDetailContext: createContext(new Map()) };
});

const { TodoFullList } = await import('./TodoView');
const { TodoDetailContext } = await import('../../App');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function todo(
  id: string,
  content: string,
  status: TodoItem['status'],
): TodoItem {
  return { id, content, status };
}

function keyOf(id: string, content: string): string {
  return todoStateKey(todo(id, content, 'completed'));
}

function render(
  todos: TodoItem[],
  details: Map<string, TodoDetail>,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TodoDetailContext.Provider value={details}>
          <TodoFullList todos={todos} />
        </TodoDetailContext.Provider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const TODOS = [
  todo('1', 'Done with stats', 'completed'),
  todo('2', 'Done without stats', 'completed'),
  todo('3', 'Running', 'in_progress'),
  todo('4', 'Later', 'pending'),
];

describe('TodoFullList detail', () => {
  it('makes only completed tasks with detail expandable', () => {
    const details = new Map<string, TodoDetail>([
      [keyOf('1', 'Done with stats'), { startTs: 1000, endTs: 4000 }],
      [keyOf('2', 'Done without stats'), { endTs: 4000 }],
    ]);
    const container = render(TODOS, details);
    // Items 1 and 2 are completed with detail; 3 (in_progress) and 4 (pending)
    // carry no detail entry and stay plain rows.
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('reveals the token and time breakdown on click', () => {
    const details = new Map<string, TodoDetail>([
      [
        keyOf('1', 'Done with stats'),
        {
          startTs: 1000,
          endTs: 4000,
          resources: {
            inputTokens: 1234,
            cachedTokens: 200,
            outputTokens: 567,
            apiTimeMs: 2500,
            toolTimeMs: 800,
          },
        },
      ],
    ]);
    const container = render([TODOS[0]], details);
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    // Collapsed: no metric rows yet.
    expect(container.textContent).not.toContain('1,234');

    click(button!);
    const text = container.textContent ?? '';
    // Section headers group the metrics.
    expect(text).toContain('Tokens');
    expect(text).toContain('Time spent');
    // Token values.
    expect(text).toContain('1,234');
    expect(text).toContain('567');
    // Time-spent values.
    expect(text).toContain('2.5s');
    expect(text).toContain('800ms');
    // 4000 - 1000 ms window.
    expect(text).toContain('3.0s');
  });

  it('shows the not-captured hint for a completed task without resources', () => {
    const details = new Map<string, TodoDetail>([
      [keyOf('2', 'Done without stats'), { startTs: 1000, endTs: 4000 }],
    ]);
    const container = render([TODOS[1]], details);
    click(container.querySelector('button')!);
    const text = container.textContent ?? '';
    expect(text).toContain("wasn't captured");
    expect(text).toContain('Time'); // the Time section still renders
    expect(text).not.toContain('Time spent'); // but not the token/spent groups
  });
});
