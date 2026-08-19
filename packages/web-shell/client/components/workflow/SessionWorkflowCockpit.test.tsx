// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
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
    const render = (
      language: WebShellLanguage,
      nextTodos: readonly TodoItem[] = todos,
    ) => {
      act(() => {
        root.render(
          <I18nProvider language={language}>
            <SessionWorkflowCockpit
              sessionId="session-12345678"
              connected
              sessionName={sessionName}
              todos={nextTodos}
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
    expect(container.textContent).toContain('计划执行');
    expect(
      container.querySelector('[data-plan-node-id="research"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-plan-node-id="deliver"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('检查与决策');
    expect(container.textContent).not.toContain('驾驶舱');
    expect(container.querySelector('h1')?.title).toBe(sessionName);

    render('en');
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('Plan execution');
    expect(container.textContent).toContain('Needs attention');

    const backToChat = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-back-to-chat"]',
    );
    act(() => backToChat?.focus());
    render('en', [
      ...todos,
      { id: 'follow-up', content: 'Follow up', status: 'pending' },
    ]);
    expect(document.activeElement).toBe(backToChat);

    act(() => root.unmount());
    container.remove();
  });

  it('opens and lists the nested Agent that caused a Todo to need attention', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const failedChild: ACPToolCall = {
      callId: 'failed-child',
      toolName: 'Agent',
      title: 'Failed child',
      status: 'failed',
      parentToolCallId: 'root-agent',
    };
    const tools: ACPToolCall[] = [
      {
        callId: 'root-agent',
        toolName: 'Agent',
        status: 'completed',
        args: { todo_id: 'work' },
        subTools: [failedChild],
      },
    ];
    const tasks = [
      {
        kind: 'agent' as const,
        id: 'root-task',
        label: 'Root agent',
        description: 'Coordinate work',
        status: 'completed' as const,
        startTime: 1,
        runtimeMs: 1,
        isBackgrounded: true,
        toolUseId: 'root-agent',
      },
      {
        kind: 'agent' as const,
        id: 'child-task',
        label: 'Failed child',
        description: 'Inspect failure',
        status: 'failed' as const,
        startTime: 2,
        runtimeMs: 1,
        isBackgrounded: true,
        toolUseId: 'failed-child',
      },
    ];
    const onOpenSubagent = vi.fn();

    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionWorkflowCockpit
            sessionId="session-1"
            connected
            todos={[{ id: 'work', content: 'Work', status: 'in_progress' }]}
            tools={tools}
            tasks={tasks}
            onBackToChat={() => undefined}
            onOpenSubagent={onOpenSubagent}
          />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('Failed child');

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Needs attention"]',
        )
        ?.click();
    });
    expect(document.activeElement).toBe(
      container.querySelector('button[aria-label="Needs attention"]'),
    );
    const openOutput = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View full Agent output',
    );
    act(() => openOutput?.click());
    expect(onOpenSubagent).toHaveBeenCalledWith(failedChild);

    act(() => root.unmount());
    container.remove();
  });
});
