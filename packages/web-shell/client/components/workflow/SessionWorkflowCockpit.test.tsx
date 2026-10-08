// @vitest-environment jsdom

import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { SessionWorkflowCockpit } from './SessionWorkflowCockpit';

const todos: TodoItem[] = [
  { id: 'research', content: 'Research', status: 'completed' },
  {
    id: 'deliver',
    content: 'Deliver',
    status: 'in_progress',
    blockedBy: ['research'],
  },
];

describe('SessionWorkflowCockpit', () => {
  it('uses the graph as a controlled canvas without duplicating step detail', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelectedTodoIdChange = vi.fn();

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionWorkflowCockpit
            sessionId="session-12345678"
            connected
            sessionName="Repository delivery"
            todos={todos}
            tools={[]}
            tasks={[]}
            selectedTodoId="research"
            onSelectedTodoIdChange={onSelectedTodoIdChange}
            onBackToChat={() => undefined}
            onOpenSubagent={() => undefined}
          />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Dependency graph');
    expect(container.textContent).toContain('Repository delivery');
    expect(container.querySelector('[data-plan-step-details]')).toBeNull();
    expect(
      container
        .querySelector('[data-plan-node-id="research"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-plan-node-id="research"]')
        ?.click();
    });
    expect(onSelectedTodoIdChange).toHaveBeenLastCalledWith('research');

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-plan-node-id="deliver"]')
        ?.click();
    });
    expect(onSelectedTodoIdChange).toHaveBeenCalledWith('deliver');

    act(() => root.unmount());
    container.remove();
  });

  it('keeps a keyboard return path under StrictMode', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="en">
            <SessionWorkflowCockpit
              sessionId="session-1"
              connected
              todos={todos}
              tools={[]}
              tasks={[]}
              onSelectedTodoIdChange={() => undefined}
              onBackToChat={() => undefined}
              onOpenSubagent={() => undefined}
            />
          </I18nProvider>
        </StrictMode>,
      );
    });

    const backToChat = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-back-to-chat"]',
    );
    expect(document.activeElement).toBe(backToChat);

    act(() => root.unmount());
    container.remove();
  });
});
