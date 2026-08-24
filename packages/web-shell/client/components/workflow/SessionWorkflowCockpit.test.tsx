// @vitest-environment jsdom

import { act, StrictMode } from 'react';
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
    // The graph's own "Plan execution" caption is suppressed here — the page
    // h1 already titles the region — so the localized graph region is asserted
    // through its overview strip and its nodes instead.
    expect(container.textContent).toContain('整体进度');
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
    expect(container.textContent).toContain('Overall progress');
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

    // The attention detail's dependency labels are localized, not raw keys.
    // `t` is untyped, so a missing dictionary entry only shows up at runtime.
    expect(container.textContent).toContain('Depends on');
    expect(container.textContent).toContain('Unblocks');
    expect(container.textContent).not.toContain('workflow.dependencies.');

    act(() => root.unmount());
    container.remove();
  });

  it('localizes the attention detail dependency labels in zh-CN', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const tools: ACPToolCall[] = [
      {
        callId: 'root-agent',
        toolName: 'Agent',
        status: 'failed',
        args: { todo_id: 'work' },
      },
    ];
    const tasks = [
      {
        kind: 'agent' as const,
        id: 'root-task',
        label: 'Root agent',
        description: 'Coordinate work',
        status: 'failed' as const,
        startTime: 1,
        runtimeMs: 1,
        isBackgrounded: true,
        toolUseId: 'root-agent',
      },
    ];

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <SessionWorkflowCockpit
            sessionId="session-1"
            connected
            todos={[{ id: 'work', content: 'Work', status: 'in_progress' }]}
            tools={tools}
            tasks={tasks}
            onBackToChat={() => undefined}
            onOpenSubagent={() => undefined}
          />
        </I18nProvider>,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="待我处理"]')
        ?.click();
    });

    expect(container.textContent).toContain('依赖于');
    expect(container.textContent).toContain('解除阻塞');
    expect(container.textContent).not.toContain('workflow.dependencies.');

    act(() => root.unmount());
    container.remove();
  });

  it('focuses the back-to-chat entry action under StrictMode effect replay', () => {
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
              onBackToChat={() => undefined}
              onOpenSubagent={() => undefined}
            />
          </I18nProvider>
        </StrictMode>,
      );
    });

    // StrictMode replays mount effects as setup -> cleanup -> setup; without
    // the entry-focus effect's cleanup the replayed setup skips the init
    // branch and focus lands on the Overview tab instead.
    const backToChat = container.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-back-to-chat"]',
    );
    expect(backToChat).not.toBeNull();
    expect(document.activeElement).toBe(backToChat);

    // Section switches still move focus to the tab after the entry focus.
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

    act(() => root.unmount());
    container.remove();
  });
});
