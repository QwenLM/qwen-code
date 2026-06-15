// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import type { TodoItem } from '../../adapters/types';

// PlanMessage imports App only for TodoTimelineContext; mock it so the unit
// test doesn't pull the whole application graph.
vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return { TodoTimelineContext: createContext(new Map()) };
});

const { PlanMessage } = await import('./PlanMessage');
const { TodoTimelineContext } = await import('../../App');

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

function renderPlan(
  id: string,
  todos: TodoItem[],
  timeline?: Map<string, unknown>,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TodoTimelineContext.Provider value={timeline ?? new Map()}>
          <PlanMessage id={id} todos={todos} />
        </TodoTimelineContext.Provider>
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
  todo('1', 'First task', 'completed'),
  todo('2', 'Second task', 'in_progress'),
  todo('3', 'Third task', 'pending'),
];

describe('PlanMessage', () => {
  it('collapses to the current step with a progress count', () => {
    const container = renderPlan('p1', TODOS);
    expect(container.textContent).toContain('1/3');
    expect(container.textContent).toContain('Second task');
    expect(container.textContent).not.toContain('Third task');
    expect(container.textContent).toContain('▸');
  });

  it('expands to the full list on click', () => {
    const container = renderPlan('p1', TODOS);
    const chevron = [...container.querySelectorAll('span')].find(
      (s) => s.textContent === '▸',
    );
    click(chevron!.parentElement!);
    expect(container.textContent).toContain('First task');
    expect(container.textContent).toContain('Second task');
    expect(container.textContent).toContain('Third task');
    expect(container.textContent).toContain('▾');
  });

  it('shows the plan-keyed diff when a timeline is present', () => {
    const timeline = new Map<string, unknown>([
      [
        'p1',
        {
          events: [
            { kind: 'completed', id: '1', content: 'First task' },
            { kind: 'started', id: '2', content: 'Second task' },
          ],
        },
      ],
    ]);
    const container = renderPlan('p1', TODOS, timeline);
    expect(container.textContent).toContain('First task');
    expect(container.textContent).toContain('Second task');
    expect(container.textContent).not.toContain('Third task');
  });

  it('shows an all-done summary when every item is completed', () => {
    const container = renderPlan('p1', [
      todo('1', 'First task', 'completed'),
      todo('2', 'Second task', 'completed'),
    ]);
    expect(container.textContent).toContain('2/2');
    expect(container.textContent).toContain('All tasks completed');
  });

  it('falls back to the first pending item when nothing is in progress', () => {
    const container = renderPlan('p1', [
      todo('1', 'First task', 'pending'),
      todo('2', 'Second task', 'pending'),
    ]);
    expect(container.textContent).toContain('0/2');
    expect(container.textContent).toContain('First task');
    expect(container.textContent).not.toContain('Second task');
  });

  it('renders nothing for an empty plan', () => {
    const container = renderPlan('p1', []);
    expect(container.textContent).toBe('');
  });
});
