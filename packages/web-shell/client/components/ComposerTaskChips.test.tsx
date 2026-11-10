// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import {
  ComposerTaskChips,
  type ComposerTaskChipsHandle,
} from './ComposerTaskChips';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Status = DaemonSessionTaskWithWorkflowStatus['status'];

function workflow(
  id: string,
  status: Status = 'running',
): DaemonSessionTaskWithWorkflowStatus {
  return {
    kind: 'workflow',
    id,
    label: `run ${id}`,
    description: `run ${id}`,
    status,
    startTime: 1_000,
    runtimeMs: 65_000,
    isBackgrounded: true,
    currentPhase: null,
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
  };
}

function shell(
  id: string,
  status: Status = 'running',
): DaemonSessionTaskWithWorkflowStatus {
  return {
    kind: 'shell',
    id,
    label: 'npm run dev',
    description: 'npm run dev',
    status,
    startTime: 1_000,
    runtimeMs: 1_000,
    command: 'npm run dev',
    cwd: '/workspace',
  };
}

describe('ComposerTaskChips', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    tasks: DaemonSessionTaskWithWorkflowStatus[],
    props: Partial<Parameters<typeof ComposerTaskChips>[0]> = {},
    ref = createRef<ComposerTaskChipsHandle>(),
  ) {
    const onSelectTask = vi.fn();
    const onReturnToInput = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ComposerTaskChips
            ref={ref}
            tasks={tasks}
            includeAgents
            onSelectTask={onSelectTask}
            onReturnToInput={onReturnToInput}
            {...props}
          />
        </I18nProvider>,
      );
    });
    return { onSelectTask, onReturnToInput, ref };
  }

  const chips = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[data-kind]'));

  it('renders nothing when no task is unfinished', () => {
    const { ref } = render([
      workflow('done', 'completed'),
      shell('failed', 'failed'),
    ]);

    expect(container.innerHTML).toBe('');
    expect(ref.current?.focus()).toBe(false);
  });

  it('shows one chip per kind of unfinished work', () => {
    render([
      shell('shell-1'),
      workflow('wf-1'),
      workflow('wf-2', 'paused'),
      workflow('wf-3', 'completed'),
    ]);

    expect(chips().map((chip) => chip.textContent)).toEqual([
      '2 workflows',
      '1 shell',
    ]);
  });

  it('keeps a pausing or paused workflow as unfinished work', () => {
    render([workflow('wf-1', 'pausing')]);
    expect(chips().map((chip) => chip.textContent)).toEqual(['1 workflow']);

    render([workflow('wf-1', 'paused')]);
    expect(chips().map((chip) => chip.textContent)).toEqual(['1 workflow']);
  });

  it('opens the task directly when its chip stands for one task', () => {
    const task = workflow('wf-1');
    const { onSelectTask } = render([task]);

    act(() => chips()[0].click());

    expect(onSelectTask).toHaveBeenCalledWith(task);
    expect(
      container.querySelector('[data-testid="composer-task-list"]'),
    ).toBeNull();
  });

  it('lists the tasks of a chip that stands for several, and opens the picked one', () => {
    const first = workflow('wf-1');
    const second = workflow('wf-2', 'paused');
    const { onSelectTask } = render([first, second]);

    act(() => chips()[0].click());
    expect(chips()[0].getAttribute('aria-expanded')).toBe('true');
    const list = container.querySelector(
      '[data-testid="composer-task-list"]',
    ) as HTMLElement;
    const rows = Array.from(list.querySelectorAll('button'));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('run wf-1'),
      // A paused run shows the runtime the snapshot recorded.
      'run wf-21m 5s',
    ]);

    act(() => rows[1].click());

    expect(onSelectTask).toHaveBeenCalledWith(second);
    expect(
      container.querySelector('[data-testid="composer-task-list"]'),
    ).toBeNull();
  });

  it('closes the list on a click outside the chips', () => {
    render([workflow('wf-1'), workflow('wf-2')]);
    act(() => chips()[0].click());

    act(() => {
      document.body.dispatchEvent(
        // jsdom has no PointerEvent; the listener only reads the target.
        new Event('pointerdown', { bubbles: true }),
      );
    });

    expect(
      container.querySelector('[data-testid="composer-task-list"]'),
    ).toBeNull();
  });

  it('focuses the first choice on opening without stealing focus on refresh', () => {
    render([workflow('wf-1'), workflow('wf-2')]);
    act(() => chips()[0].click());

    const rows = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="composer-task-list"] button',
    );
    expect(document.activeElement).toBe(rows[0]);

    rows[1].focus();
    render([workflow('wf-1'), workflow('wf-2')]);
    expect(document.activeElement).toBe(rows[1]);

    act(() => {
      rows[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      container.querySelector('[data-testid="composer-task-list"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(chips()[0]);

    act(() => chips()[0].click());
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="composer-task-list"] button'),
    );
  });

  it('drops a chip once its task finishes', () => {
    render([workflow('wf-1'), shell('shell-1')]);
    expect(chips()).toHaveLength(2);

    render([workflow('wf-1', 'completed'), shell('shell-1')]);

    expect(chips().map((chip) => chip.textContent)).toEqual(['1 shell']);
  });

  it('moves focus between chips and back to the composer from the keyboard', () => {
    const { onReturnToInput, ref } = render([
      workflow('wf-1'),
      shell('shell-1'),
    ]);

    act(() => {
      expect(ref.current?.focus()).toBe(true);
    });
    expect(document.activeElement).toBe(chips()[0]);

    act(() => {
      chips()[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(chips()[1]);

    act(() => {
      chips()[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(onReturnToInput).toHaveBeenCalledWith();

    act(() => {
      chips()[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
      );
    });
    expect(onReturnToInput).toHaveBeenLastCalledWith('a');
  });
});
