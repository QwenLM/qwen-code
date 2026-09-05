// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { EnvironmentAgentTask } from '../panels/EnvironmentPanel';
import { AgentWorkflow } from './AgentWorkflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tasks: EnvironmentAgentTask[] = [
  {
    kind: 'agent',
    id: 'parent',
    label: 'Parent',
    description: 'Parent task',
    status: 'completed',
    startTime: 1_000,
    endTime: 2_000,
    runtimeMs: 1_000,
    isBackgrounded: true,
  },
  {
    kind: 'agent',
    id: 'child',
    parentAgentId: 'parent',
    label: 'Child',
    description: 'Child task',
    status: 'running',
    startTime: Date.now() - 2_000,
    runtimeMs: 2_000,
    isBackgrounded: true,
  },
];

describe('AgentWorkflow', () => {
  it('renders lineage and opens a selected agent', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onOpenAgent = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <AgentWorkflow tasks={tasks} onOpenAgent={onOpenAgent} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Main agent');
    expect(
      container.querySelector('[data-testid="agent-workflow-edges"]')?.children,
    ).toHaveLength(2);
    const child = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Child'),
    );
    act(() => child?.click());
    expect(onOpenAgent).toHaveBeenCalledWith(tasks[1]);
    act(() => root.unmount());
  });

  it('shows a skeleton only before the first trace is available', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <AgentWorkflow tasks={[]} loading />
        </I18nProvider>,
      );
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    act(() => {
      root.render(
        <I18nProvider language="en">
          <AgentWorkflow tasks={tasks} />
        </I18nProvider>,
      );
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('Parent');
    act(() => root.unmount());
  });

  it('shows trace errors even when live agent tasks are available', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <AgentWorkflow tasks={tasks} error="Workflow failed to load" />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('Workflow failed to load');
    act(() => root.unmount());
  });

  it('keeps a fork-prefixed label for non-fork agents', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const nonForkTask: EnvironmentAgentTask = {
      ...tasks[0],
      label: 'fork: investigate',
      subagentType: 'general-purpose',
    };
    act(() => {
      root.render(
        <I18nProvider language="en">
          <AgentWorkflow tasks={[nonForkTask]} />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toContain('fork: investigate');
    act(() => root.unmount());
  });
});
