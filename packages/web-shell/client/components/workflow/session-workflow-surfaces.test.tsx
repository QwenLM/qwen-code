// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { SessionWorkflowCockpit } from './SessionWorkflowCockpit';
import { SessionWorkflowInspector } from './SessionWorkflowInspector';

// Acceptance #10865: the cockpit, the inspector and the graph embedded in
// the cockpit share one projection per render instead of deriving three
// copies. These counters watch both the projection build and the
// task-execution index it carries; a regression re-introduces extra builds
// in the component bodies (App builds exactly one and passes it down).
// In its own file so the module mocks cannot reach the behavioural suites.
const counts = vi.hoisted(() => ({ projections: 0, indexBuilds: 0 }));

vi.mock('./session-workflow-model', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./session-workflow-model')>();
  return {
    ...actual,
    buildSessionWorkflowProjection: (
      ...args: Parameters<typeof actual.buildSessionWorkflowProjection>
    ) => {
      counts.projections += 1;
      return actual.buildSessionWorkflowProjection(...args);
    },
  };
});

vi.mock('../messages/taskExecutionIndex', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../messages/taskExecutionIndex')>();
  return {
    ...actual,
    createTaskExecutionIndex: (
      ...args: Parameters<typeof actual.createTaskExecutionIndex>
    ) => {
      counts.indexBuilds += 1;
      return actual.createTaskExecutionIndex(...args);
    },
  };
});

const { buildSessionWorkflowProjection } = await import(
  './session-workflow-model'
);

const todos: TodoItem[] = [
  { id: 'prepare', content: 'Prepare inputs', status: 'completed' },
  {
    id: 'build',
    content: 'Build the thing',
    status: 'in_progress',
    blockedBy: ['prepare'],
  },
  {
    id: 'verify',
    content: 'Verify the thing',
    status: 'pending',
    blockedBy: ['build'],
  },
];

const tools: ACPToolCall[] = [
  {
    callId: 'build-step',
    toolName: 'workflow_step',
    status: 'in_progress',
    args: { todo_id: 'build' },
    subTools: [
      {
        callId: 'build-agent',
        toolName: 'Agent',
        title: 'Build Agent',
        status: 'in_progress',
      },
    ],
  },
];

const tasks: DaemonSessionTaskStatus[] = [
  {
    kind: 'agent',
    id: 'build-task',
    label: 'Build Agent',
    description: 'Building',
    status: 'running',
    startTime: 1,
    runtimeMs: 1_000,
    isBackgrounded: false,
    toolUseId: 'build-agent',
  },
];

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
  return container;
}

describe('session workflow surfaces share one projection', () => {
  it('builds no extra projection or index when the app passes one down', () => {
    // The app-level derivation (App.tsx memoizes one projection per render
    // and hands the same object to every surface). This call is the single
    // build for the whole render; the counters below must stay at zero.
    const shared = buildSessionWorkflowProjection(todos, tools, tasks);
    expect(counts.projections).toBe(1);
    expect(counts.indexBuilds).toBe(1);
    counts.projections = 0;
    counts.indexBuilds = 0;

    const onSelectedTodoIdChange = vi.fn();
    const container = mount(
      <>
        <SessionWorkflowCockpit
          sessionId="session-1"
          connected
          todos={todos}
          tools={tools}
          tasks={tasks}
          projection={shared}
          onSelectedTodoIdChange={onSelectedTodoIdChange}
          onBackToChat={vi.fn()}
          onOpenSubagent={vi.fn()}
        />
        <SessionWorkflowInspector
          todos={todos}
          tools={tools}
          tasks={tasks}
          projection={shared}
          artifacts={[]}
          onSelectedTodoIdChange={onSelectedTodoIdChange}
          onExpandGraph={vi.fn()}
          onOpenSubagent={vi.fn()}
        />
      </>,
    );

    // The cockpit (with its embedded graph) and the inspector rendered from
    // the shared projection without re-deriving it or its task index.
    expect(counts.projections).toBe(0);
    expect(counts.indexBuilds).toBe(0);
    expect(
      container.querySelector('[data-testid="session-workflow-cockpit"]'),
    ).toBeTruthy();
    // The embedded graph derived its nodes from the same projection.
    expect(
      container.querySelector('[data-plan-node-id="verify"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain('Verify the thing');
    // The inspector reads the same state the cockpit header does.
    expect(container.textContent).toContain('Build the thing');
  });

  it('derives the projection once for a standalone cockpit tree', () => {
    counts.projections = 0;
    counts.indexBuilds = 0;

    const container = mount(
      <SessionWorkflowCockpit
        sessionId="session-1"
        connected
        todos={todos}
        tools={tools}
        tasks={tasks}
        onSelectedTodoIdChange={vi.fn()}
        onBackToChat={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    );

    // One projection per render: the cockpit derives it and the embedded
    // graph reuses it — the graph used to rebuild its own grouping, node
    // states and counts from the raw props. One task index per projection.
    expect(counts.projections).toBe(1);
    expect(counts.indexBuilds).toBe(1);
    expect(
      container.querySelector('[data-plan-node-id="verify"]'),
    ).toBeTruthy();
  });

  it('derives the projection once for a standalone inspector', () => {
    counts.projections = 0;
    counts.indexBuilds = 0;

    const container = mount(
      <SessionWorkflowInspector
        todos={todos}
        tools={tools}
        tasks={tasks}
        artifacts={[]}
        onSelectedTodoIdChange={vi.fn()}
        onExpandGraph={vi.fn()}
        onOpenSubagent={vi.fn()}
      />,
    );

    expect(counts.projections).toBe(1);
    expect(counts.indexBuilds).toBe(1);
    expect(container.textContent).toContain('Verify the thing');
  });
});
