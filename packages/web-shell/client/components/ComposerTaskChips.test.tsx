// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionSubSessionTaskStatus,
  DaemonSessionTaskWithWorkflowStatus,
} from '@qwen-code/sdk/daemon';
import type { ComposerChipTask } from '../utils/composerTasks';
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

function sent(
  id: string,
  status: DaemonSessionSubSessionTaskStatus['status'] = 'running',
): DaemonSessionSubSessionTaskStatus {
  return {
    kind: 'session',
    id,
    sessionId: id,
    workspaceCwd: '/work/b',
    label: `look at ${id}`,
    status,
    startTime: 1_000,
    runtimeMs: 2_000,
    byPerson: true,
  };
}

describe('ComposerTaskChips', () => {
  let container: HTMLDivElement;
  let root: Root;
  let outsideInput: HTMLInputElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    outsideInput = document.createElement('input');
    document.body.append(outsideInput);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    outsideInput.remove();
  });

  function render(
    tasks: ComposerChipTask[],
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

  it('shows a message sent to another session while it runs there', () => {
    const { onSelectTask } = render([
      shell('shell-1'),
      sent('kid-1'),
      sent('kid-2', 'completed'),
    ]);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      '1 other session',
      '1 shell',
    ]);
    act(() => chips()[0]!.click());
    expect(onSelectTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', sessionId: 'kid-1' }),
    );
  });

  it('says so when a session a message went to is waiting for an answer', () => {
    const { onSelectTask } = render([
      { ...sent('kid-1'), waitingForInput: true },
    ]);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      '1 session needs your answer',
    ]);
    expect(chips()[0]!.hasAttribute('data-waiting')).toBe(true);
    act(() => chips()[0]!.click());
    expect(onSelectTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'kid-1' }),
    );
  });

  it('counts only the waiting sessions in the waiting label', () => {
    render([sent('kid-1'), { ...sent('kid-2'), waitingForInput: true }]);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      '1 session needs your answer',
    ]);
    expect(sent('kid-1').waitingForInput).toBeUndefined();
    expect(chips()[0]!.hasAttribute('data-waiting')).toBe(true);
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

  it('offers no explain button for a message sent to another session', () => {
    const onExplainTask = vi.fn();
    render([sent('kid-1'), shell('shell-1')], { onExplainTask });
    const explains = Array.from(
      container.querySelectorAll('[data-testid="composer-task-explain"]'),
    );
    expect(
      explains.map((button) => button.getAttribute('data-explain-kind')),
    ).toEqual(['shell']);

    render([sent('kid-1'), sent('kid-2')], { onExplainTask });
    act(() => chips()[0]!.click());
    expect(
      container.querySelector(
        '[data-testid="composer-task-list"] [data-testid="composer-task-explain"]',
      ),
    ).toBeNull();
  });

  it('lists several sessions by name alone, with no icon', () => {
    render([sent('kid-1'), sent('kid-2')]);
    act(() => chips()[0]!.click());
    const list = container.querySelector(
      '[data-testid="composer-task-list"]',
    ) as HTMLElement;
    const rows = Array.from(list.querySelectorAll('button'));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('look at kid-1'),
      expect.stringContaining('look at kid-2'),
    ]);
    expect(list.querySelector('svg')).toBeNull();
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

  it.each([false, true])(
    'selects a task after an inside pointerdown (shadow root: %s)',
    (useShadowRoot) => {
      let scope: ParentNode = container;
      if (useShadowRoot) {
        act(() => root.unmount());
        const shadowRoot = container.attachShadow({ mode: 'open' });
        const mount = document.createElement('div');
        shadowRoot.append(mount);
        root = createRoot(mount);
        scope = shadowRoot;
      }
      const first = workflow('wf-1');
      const second = workflow('wf-2');
      const { onSelectTask } = render([first, second]);
      const chip = scope.querySelector<HTMLButtonElement>('[data-kind]')!;
      act(() => chip.click());
      const list = scope.querySelector('[data-testid="composer-task-list"]')!;
      const row = list.querySelectorAll('button')[1];

      act(() => {
        row
          .querySelector('span')!
          .dispatchEvent(
            new Event('pointerdown', { bubbles: true, composed: true }),
          );
      });
      expect(list.isConnected).toBe(true);
      act(() => row.click());
      expect(onSelectTask).toHaveBeenCalledExactlyOnceWith(second);

      act(() => chip.click());
      act(() => {
        outsideInput.dispatchEvent(
          new Event('pointerdown', { bubbles: true, composed: true }),
        );
      });
      expect(
        scope.querySelector('[data-testid="composer-task-list"]'),
      ).toBeNull();
    },
  );

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

  it('closes only when focus leaves the list and chips', () => {
    render([workflow('wf-1'), workflow('wf-2')]);
    act(() => chips()[0].click());
    const list = container.querySelector('[data-testid="composer-task-list"]');
    const rows = list!.querySelectorAll('button');

    act(() => rows[1].focus());
    expect(list!.isConnected).toBe(true);
    act(() => chips()[0].focus());
    expect(list!.isConnected).toBe(true);

    act(() => outsideInput.focus());
    expect(list!.isConnected).toBe(false);
    render([workflow('wf-1'), workflow('wf-2')]);
    expect(document.activeElement).toBe(outsideInput);
  });

  it('returns selection focus to its chip before opening the task surface', () => {
    let focusAtSelection: Element | null = null;
    const onSelectTask = vi.fn(() => {
      focusAtSelection = document.activeElement;
      outsideInput.focus();
    });
    render([workflow('wf-1'), workflow('wf-2')], { onSelectTask });
    act(() => chips()[0].click());
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composer-task-list"] button',
        )!
        .click();
    });

    expect(onSelectTask).toHaveBeenCalledOnce();
    expect(focusAtSelection).toBe(chips()[0]);
    expect(document.activeElement).toBe(outsideInput);
  });

  it.each([2, 3])(
    'returns focus to the chip when a focused task finishes out of %i tasks',
    (count) => {
      const tasks = Array.from({ length: count }, (_, i) =>
        workflow(`wf-${i}`),
      );
      render(tasks);
      act(() => chips()[0].click());

      render([workflow('wf-0', 'completed'), ...tasks.slice(1)]);

      expect(document.activeElement).toBe(chips()[0]);
      expect(
        container.querySelector('[data-testid="composer-task-list"]') !== null,
      ).toBe(count > 2);
    },
  );

  it('returns to the composer when the last focused chip disappears', () => {
    const onReturnToInput = vi.fn(() => outsideInput.focus());
    render([workflow('wf-1')], { onReturnToInput });
    act(() => chips()[0].focus());

    render([workflow('wf-1', 'completed')], { onReturnToInput });

    expect(onReturnToInput).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(outsideInput);
  });

  it('does not reclaim outside focus when tasks finish', () => {
    const onReturnToInput = vi.fn();
    render([workflow('wf-1'), workflow('wf-2')], { onReturnToInput });
    act(() => chips()[0].click());
    act(() => outsideInput.focus());

    render([], { onReturnToInput });

    expect(onReturnToInput).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outsideInput);
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

  describe('explain affordance', () => {
    const explainButtons = (scope: ParentNode = container) =>
      Array.from(
        scope.querySelectorAll<HTMLButtonElement>(
          '[data-testid="composer-task-explain"]',
        ),
      );

    it('offers a "?" beside a single-task chip that asks without opening', () => {
      const task = shell('shell-1');
      const onExplainTask = vi.fn();
      const { onSelectTask } = render([task], { onExplainTask });

      const explains = explainButtons();
      expect(explains).toHaveLength(1);
      expect(explains[0].getAttribute('aria-label')).toBe(
        'Explain task: npm run dev',
      );
      expect(explains[0].getAttribute('title')).toBe(
        'Explain what this task is doing',
      );

      act(() => explains[0].click());

      expect(onExplainTask).toHaveBeenCalledExactlyOnceWith(task);
      expect(onSelectTask).not.toHaveBeenCalled();
    });

    it('keeps the chip itself opening the task', () => {
      const task = shell('shell-1');
      const onExplainTask = vi.fn();
      const { onSelectTask } = render([task], { onExplainTask });

      act(() => chips()[0].click());

      expect(onSelectTask).toHaveBeenCalledExactlyOnceWith(task);
      expect(onExplainTask).not.toHaveBeenCalled();
    });

    it('offers one "?" per list row and keeps the list open on ask', () => {
      const first = workflow('wf-1');
      const second = workflow('wf-2');
      const onExplainTask = vi.fn();
      const { onSelectTask } = render([first, second], { onExplainTask });

      // The multi-task chip itself has no "?"; its rows do.
      expect(explainButtons()).toHaveLength(0);

      act(() => chips()[0].click());
      const list = container.querySelector(
        '[data-testid="composer-task-list"]',
      )!;
      const explains = explainButtons(list);
      expect(explains).toHaveLength(2);

      act(() => explains[1].click());

      expect(onExplainTask).toHaveBeenCalledExactlyOnceWith(second);
      expect(onSelectTask).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="composer-task-list"]'),
      ).not.toBeNull();
    });

    it('renders no "?" when the host does not wire explanation', () => {
      // Single-task first: with a multi-task group the `multiple` operand
      // short-circuits, leaving the opt-out operand itself untested.
      render([workflow('wf-1')]);
      expect(explainButtons()).toHaveLength(0);

      render([workflow('wf-1'), workflow('wf-2')]);
      expect(explainButtons()).toHaveLength(0);

      act(() => chips()[0].click());
      expect(explainButtons()).toHaveLength(0);
    });

    it('closes the list back to its chip on Escape from a row "?"', () => {
      const onExplainTask = vi.fn();
      render([workflow('wf-1'), workflow('wf-2')], { onExplainTask });
      act(() => chips()[0].click());

      act(() => {
        explainButtons()[1].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });

      expect(
        container.querySelector('[data-testid="composer-task-list"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(chips()[0]);
      expect(onExplainTask).not.toHaveBeenCalled();
    });

    it('drops back to the composer from the chip "?" keyboard', () => {
      const onExplainTask = vi.fn();
      const { onReturnToInput } = render([shell('shell-1')], { onExplainTask });
      const explain = explainButtons()[0];

      act(() => {
        explain.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(onReturnToInput).toHaveBeenCalledWith();

      act(() => {
        explain.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
        );
      });
      expect(onReturnToInput).toHaveBeenLastCalledWith('a');
    });

    it('returns focus to the composer when the explained task finishes', () => {
      const onExplainTask = vi.fn();
      const onReturnToInput = vi.fn(() => outsideInput.focus());
      render([workflow('wf-1')], { onExplainTask, onReturnToInput });
      act(() => explainButtons()[0].focus());

      render([workflow('wf-1', 'completed')], {
        onExplainTask,
        onReturnToInput,
      });

      expect(onReturnToInput).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(outsideInput);
    });

    it('grows a chip "?" when its group shrinks to one task', () => {
      const remaining = workflow('wf-1');
      const onExplainTask = vi.fn();
      render([remaining, workflow('wf-2')], { onExplainTask });
      act(() => chips()[0].click());
      expect(explainButtons()).toHaveLength(2);

      render([remaining], { onExplainTask });

      expect(
        container.querySelector('[data-testid="composer-task-list"]'),
      ).toBeNull();
      const explains = explainButtons();
      expect(explains).toHaveLength(1);
      act(() => explains[0].click());
      expect(onExplainTask).toHaveBeenCalledExactlyOnceWith(remaining);
    });

    it('keeps the focused chip node across the 1↔2 task boundary', () => {
      const onExplainTask = vi.fn();
      const shellTask = shell('shell-1');
      render([workflow('wf-1'), shellTask], { onExplainTask });
      const shellChip = chips()[1];
      act(() => shellChip.focus());

      render([workflow('wf-1'), shellTask, shell('shell-2')], {
        onExplainTask,
      });
      expect(shellChip.isConnected).toBe(true);
      expect(document.activeElement).toBe(shellChip);

      render([workflow('wf-1'), shellTask], { onExplainTask });
      expect(shellChip.isConnected).toBe(true);
      expect(document.activeElement).toBe(shellChip);
    });

    it('keeps the aria label short for a multi-KB command label', () => {
      const onExplainTask = vi.fn();
      const command = 'echo ' + 'x'.repeat(4_000);
      render([{ ...shell('shell-1'), label: command, command }], {
        onExplainTask,
      });
      const aria = explainButtons()[0].getAttribute('aria-label') ?? '';
      expect(aria.length).toBeLessThanOrEqual(150);
      expect(aria).toContain('…');
    });

    it('renders the zh aria label and tooltip', () => {
      const onExplainTask = vi.fn();
      act(() => {
        root.render(
          <I18nProvider language="zh-CN">
            <ComposerTaskChips
              tasks={[shell('shell-1')]}
              includeAgents
              onSelectTask={vi.fn()}
              onExplainTask={onExplainTask}
            />
          </I18nProvider>,
        );
      });
      const explain = explainButtons()[0];
      expect(explain.getAttribute('aria-label')).toBe('解释任务：npm run dev');
      expect(explain.getAttribute('title')).toBe('解释这个任务在做什么');
    });

    it('reclaims focus to the owning chip when its "?" unmounts on group growth', () => {
      const onExplainTask = vi.fn();
      const shellTask = shell('shell-1');
      render([workflow('wf-1'), shellTask], { onExplainTask });
      const shellExplain = explainButtons()[1];
      act(() => shellExplain.focus());

      render([workflow('wf-1'), shellTask, shell('shell-2')], {
        onExplainTask,
      });

      expect(shellExplain.isConnected).toBe(false);
      const shellChip = chips().find((chip) =>
        chip.textContent?.includes('shells'),
      );
      expect(shellChip).toBeDefined();
      expect(document.activeElement).toBe(shellChip);
    });

    it("reclaims focus to the owning chip when a different group's list is open", () => {
      const onExplainTask = vi.fn();
      const shellTask = shell('shell-1');
      render([workflow('wf-1'), workflow('wf-2'), shellTask], {
        onExplainTask,
      });
      // Open the workflow list, then stand on the shell chip's "?" — the
      // list stays open because focus remains inside the chip row root.
      act(() => chips()[0].click());
      const shellExplain = explainButtons().find(
        (button) => button.getAttribute('data-explain-kind') === 'shell',
      );
      expect(shellExplain).toBeDefined();
      act(() => shellExplain!.focus());
      expect(
        container.querySelector('[data-testid="composer-task-list"]'),
      ).not.toBeNull();

      render(
        [workflow('wf-1'), workflow('wf-2'), shellTask, shell('shell-2')],
        {
          onExplainTask,
        },
      );

      expect(shellExplain!.isConnected).toBe(false);
      const shellChip = chips().find((chip) =>
        chip.textContent?.includes('shells'),
      );
      expect(shellChip).toBeDefined();
      expect(document.activeElement).toBe(shellChip);
    });

    it('steps ArrowLeft from the chip "?" back to its own chip', () => {
      const onExplainTask = vi.fn();
      render([workflow('wf-1'), shell('shell-1')], { onExplainTask });
      const explains = explainButtons();

      act(() => explains[0].focus());
      act(() => {
        explains[0].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(chips()[0]);

      act(() => explains[1].focus());
      act(() => {
        explains[1].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(chips()[1]);

      // ArrowRight keeps the chip arithmetic: from the last "?" it wraps.
      act(() => explains[1].focus());
      act(() => {
        explains[1].dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(chips()[0]);
    });
  });

  it('renders a scheduled-task chip when activeScheduledCount > 0 and opens on click', () => {
    const onOpenScheduledTasks = vi.fn();
    render([], { activeScheduledCount: 2, onOpenScheduledTasks });

    const scheduledChip = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-scheduled-chip"]',
    );
    expect(scheduledChip).not.toBeNull();
    expect(scheduledChip?.textContent).toContain('2 scheduled tasks');
    act(() => scheduledChip?.click());
    expect(onOpenScheduledTasks).toHaveBeenCalledOnce();
  });
});
