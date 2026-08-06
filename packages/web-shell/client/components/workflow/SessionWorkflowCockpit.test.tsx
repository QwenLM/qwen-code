// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../../adapters/types';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { SessionWorkflowCockpit } from './SessionWorkflowCockpit';

const todos: TodoItem[] = [
  { id: 'research', content: 'Research', status: 'completed' },
  {
    id: 'deliver',
    content: 'Deliver',
    status: 'completed',
    blockedBy: ['research'],
  },
];

describe('SessionWorkflowCockpit', () => {
  it('renders localized completion hierarchy and preserves the full title', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const sessionName =
      'A very long workflow title that must remain accessible';
    const render = (language: WebShellLanguage) => {
      act(() => {
        root.render(
          <I18nProvider language={language}>
            <SessionWorkflowCockpit
              sessionId="session-12345678"
              connected
              sessionName={sessionName}
              todos={todos}
              tools={[]}
              tasks={[]}
              onBackToChat={() => undefined}
              onOpenSubagent={() => undefined}
            />
          </I18nProvider>,
        );
      });
    };

    render('zh-CN');
    expect(container.textContent).toContain('已完成');
    expect(container.textContent).toContain('无需处理');
    expect(container.textContent).not.toContain('Agent 正在工作');
    expect(container.textContent).not.toContain('HISTORY SESSION');
    expect(container.textContent).not.toContain('daemon connected');
    expect(container.querySelector('h1')?.title).toBe(sessionName);

    render('en');
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('History session');
    expect(container.textContent).toContain('Checks and decisions');

    act(() => root.unmount());
    container.remove();
  });
});
