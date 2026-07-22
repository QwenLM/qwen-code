// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';

const actions = vi.hoisted(() => ({
  listGoals: vi.fn(),
  controlGoal: vi.fn(),
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { GoalsDialog } = await import('./GoalsDialog');

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

interface MockGoal {
  sessionId: string;
  displayName: string | null;
  snapshot: GoalSnapshotV2;
}

const goal = (
  over: Partial<NonNullable<GoalSnapshotV2['goal']>> = {},
  snapshotOver: Partial<GoalSnapshotV2> = {},
): MockGoal => ({
  sessionId: 'sess-1',
  displayName: 'Release work',
  snapshot: {
    v: 2,
    activity: 'running',
    goal: {
      goalId: 'goal-1',
      revision: 7,
      objective: 'ship all surfaces',
      status: 'active',
      evidenceCursor: { recordId: 'record-1' },
      turnCount: 9,
      activeTimeMs: 8_000,
      createdAt: 1_000,
      updatedAt: 9_000,
      lastReason: 'desktop still needs verification',
      ...over,
    },
    ...snapshotOver,
  },
});

describe('GoalsDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onCreateGoal = vi.fn();
  const onOpenSession = vi.fn();
  const onError = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });
    actions.controlGoal.mockResolvedValue({
      snapshot: { v: 2, goal: null, activity: 'idle' },
    });
    onCreateGoal.mockReset();
    onOpenSession.mockReset();
    onError.mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function mount(goals: MockGoal[] = []) {
    actions.listGoals.mockResolvedValue({ goals, droppedCount: 0 });
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={onCreateGoal}
            onOpenSession={onOpenSession}
            onError={onError}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
  }

  const button = (name: string) =>
    Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === name,
    ) as HTMLButtonElement | undefined;

  const iconButton = (label: string) =>
    container.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement | null;

  it('shows an empty authoritative workspace', async () => {
    await mount();
    expect(container.textContent).toContain('No active goals');
    expect(actions.listGoals).toHaveBeenCalledOnce();
  });

  it('renders v2 status, activity, reason and active elapsed without turn budgets', async () => {
    await mount([goal()]);
    expect(container.textContent).toContain('ship all surfaces');
    expect(container.textContent).toContain('In progress');
    expect(container.textContent).toContain('Working');
    expect(container.textContent).toContain('desktop still needs verification');
    expect(
      container.querySelector('[data-testid="goal-elapsed"]')?.textContent,
    ).toBe('9s');
    expect(container.textContent).not.toContain('9 turns');
  });

  it('pauses with the exact displayed goal id and revision', async () => {
    await mount([goal()]);
    await act(async () => {
      iconButton('Pause goal')?.click();
      await Promise.resolve();
    });
    expect(actions.controlGoal).toHaveBeenCalledWith('sess-1', {
      action: 'pause',
      expectedGoalId: 'goal-1',
      expectedRevision: 7,
    });
  });

  it('resumes paused, blocked and usage-limited goals', async () => {
    for (const status of ['paused', 'blocked', 'usage_limited'] as const) {
      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <GoalsDialog
              onCreateGoal={onCreateGoal}
              onOpenSession={onOpenSession}
              onError={onError}
            />
          </I18nProvider>,
        );
      });
      actions.listGoals.mockResolvedValue({
        goals: [goal({ status })],
        droppedCount: 0,
      });
      await act(async () => {
        button('Refresh')?.click();
        await Promise.resolve();
      });
      actions.controlGoal.mockClear();
      await act(async () => {
        iconButton('Resume goal')?.click();
        await Promise.resolve();
      });
      expect(actions.controlGoal).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          action: 'resume',
          expectedGoalId: 'goal-1',
          expectedRevision: 7,
        }),
      );
    }
  });

  it('clears through the same versioned control endpoint', async () => {
    await mount([goal()]);
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });
    await act(async () => {
      iconButton('Clear goal')?.click();
      await Promise.resolve();
    });
    expect(window.confirm).not.toHaveBeenCalled();
    expect(actions.controlGoal).toHaveBeenCalledWith('sess-1', {
      action: 'clear',
      expectedGoalId: 'goal-1',
      expectedRevision: 7,
    });
    expect(container.textContent).toContain('No active goals');
  });

  it('edits through optimistic concurrency and reloads', async () => {
    await mount([goal()]);
    act(() => iconButton('Edit goal')?.click());
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('ship all surfaces');
    act(() => {
      setTextareaValue(textarea, 'ship every surface');
    });
    await act(async () => {
      button('Save')?.click();
      await Promise.resolve();
    });
    expect(actions.controlGoal).toHaveBeenCalledWith('sess-1', {
      action: 'edit',
      objective: 'ship every surface',
      expectedGoalId: 'goal-1',
      expectedRevision: 7,
    });
  });

  it('keeps a pending edit visible and locks every close path', async () => {
    let resolveControl!: (value: { snapshot: GoalSnapshotV2 }) => void;
    actions.controlGoal.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveControl = resolve;
        }),
    );
    await mount([goal()]);
    act(() => iconButton('Edit goal')?.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const textarea = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    act(() => {
      setTextareaValue(textarea, 'ship while locked');
      button('Save')?.click();
    });

    const cancel = button('Cancel')!;
    const saving = button('Saving…')!;
    const close = dialog.querySelector<HTMLButtonElement>(
      '[aria-label="close"]',
    )!;
    expect(textarea.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(saving.disabled).toBe(true);

    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    )!;
    act(() => {
      close.click();
      cancel.click();
      dialog.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Escape',
        }),
      );
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);

    await act(async () => {
      resolveControl({
        snapshot: { v: 2, goal: null, activity: 'idle' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('creates in the current session callback without reserving clear keywords', async () => {
    onCreateGoal.mockResolvedValue(undefined);
    await mount();
    act(() => button('New goal')?.click());
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      setTextareaValue(textarea, 'clear');
    });
    await act(async () => {
      button('Set goal')?.click();
      await Promise.resolve();
    });
    expect(onCreateGoal).toHaveBeenCalledWith('clear');
  });

  it('opens the owning session from the card', async () => {
    await mount([goal()]);
    act(() => button('Release work')?.click());
    expect(onOpenSession).toHaveBeenCalledWith('sess-1');
  });

  it('reports a stale-version control error and refreshes authoritative state', async () => {
    await mount([goal()]);
    actions.controlGoal.mockRejectedValue(new Error('revision conflict'));
    await act(async () => {
      iconButton('Pause goal')?.click();
      await Promise.resolve();
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'revision conflict' }),
      'Failed to pause the goal',
    );
  });

  it('does not overlap a slow workspace poll', async () => {
    let resolveList: ((value: { goals: []; droppedCount: 0 }) => void) | null =
      null;
    actions.listGoals.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={onCreateGoal}
            onOpenSession={onOpenSession}
            onError={onError}
          />
        </I18nProvider>,
      );
    });
    expect(actions.listGoals).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(actions.listGoals).toHaveBeenCalledOnce();
    await act(async () => {
      resolveList?.({ goals: [], droppedCount: 0 });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(2);
  });
});
