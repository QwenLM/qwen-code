// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

interface MockTask {
  id: string;
  name: string | null;
  cron: string;
  prompt: string;
  recurring: boolean;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  nextRunAt: number | null;
  sessionId: string | null;
  runs: Array<{ at: number; kind?: 'scheduled' | 'catch-up' }>;
}

const { actions } = vi.hoisted(() => ({
  actions: {
    listScheduledTasks: vi.fn(),
    createScheduledTask: vi.fn(),
    updateScheduledTask: vi.fn(),
    runScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { ScheduledTasksDialog } = await import('./ScheduledTasksDialog');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(
  tasks: MockTask[],
  opts: {
    onOpenSession?: (sessionId: string) => void;
    onRunPrompt?: (
      prompt: string,
      sessionId: string | null,
    ) => void | Promise<void>;
    onError?: (error: unknown, message: string) => void;
  } = {},
) {
  actions.listScheduledTasks.mockResolvedValue(tasks);
  actions.updateScheduledTask.mockResolvedValue(tasks[0]);
  actions.runScheduledTask.mockResolvedValue(tasks[0]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <ScheduledTasksDialog
          onRunPrompt={opts.onRunPrompt ?? vi.fn()}
          onCreateViaChat={vi.fn()}
          onOpenSession={opts.onOpenSession}
          onError={opts.onError ?? vi.fn()}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

// Flush the async list load (and any post-action reload) so state settles.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target not found');
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

const baseTask = (over: Partial<MockTask>): MockTask => ({
  id: 't1',
  name: 'Digest',
  cron: '30 12 * * 1-5',
  prompt: 'summarize the day',
  recurring: true,
  enabled: true,
  createdAt: 1_700_000_000_000,
  lastFiredAt: null,
  nextRunAt: null,
  sessionId: null,
  runs: [],
  ...over,
});

describe('ScheduledTasksDialog editing', () => {
  it('prefills the form from the task and saves via updateScheduledTask', async () => {
    await mount([baseTask({})]);

    // Open the edit form for the (only) task.
    click(document.querySelector('[aria-label="Edit"]'));

    // The cron reverses onto the structured pickers (weekdays @ 12:30) and the
    // name/prompt are prefilled — not left blank as they would be for create.
    const name = document.querySelector<HTMLInputElement>('input[type="text"]');
    const prompt = document.querySelector<HTMLTextAreaElement>('textarea');
    const frequency = document.querySelector<HTMLSelectElement>('select');
    const time = document.querySelector<HTMLInputElement>('input[type="time"]');
    expect(name?.value).toBe('Digest');
    expect(prompt?.value).toBe('summarize the day');
    expect(frequency?.value).toBe('weekdays');
    expect(time?.value).toBe('12:30');

    // Saving routes through update (not create), sending only the editable
    // fields so recurring/enabled are left untouched.
    click(findButton('Save'));
    await flush();

    expect(actions.updateScheduledTask).toHaveBeenCalledWith('t1', {
      cron: '30 12 * * 1-5',
      prompt: 'summarize the day',
      name: 'Digest',
    });
    expect(actions.createScheduledTask).not.toHaveBeenCalled();
  });

  it('an unrepresentable cron lands in the custom field, losslessly', async () => {
    await mount([baseTask({ cron: '0 9 * * 1,3,5' })]); // day-of-week list

    click(document.querySelector('[aria-label="Edit"]'));
    const frequency = document.querySelector<HTMLSelectElement>('select');
    expect(frequency?.value).toBe('custom');

    click(findButton('Save'));
    await flush();
    // The raw expression round-trips unchanged rather than being rewritten.
    expect(actions.updateScheduledTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ cron: '0 9 * * 1,3,5' }),
    );
  });
});

describe('ScheduledTasksDialog run history', () => {
  it('toggles the run list open, newest-first, tagging late fires', async () => {
    await mount([
      baseTask({
        runs: [
          { at: 1_700_000_100_000, kind: 'scheduled' },
          { at: 1_700_000_200_000, kind: 'catch-up' },
        ],
      }),
    ]);

    // Collapsed by default — no list items rendered.
    expect(document.querySelectorAll('li').length).toBe(0);
    const toggle = document.querySelector<HTMLButtonElement>(
      'button[aria-expanded]',
    );
    expect(toggle?.textContent).toBe('Run history (2)');

    click(toggle);
    const items = Array.from(document.querySelectorAll('li'));
    expect(items).toHaveLength(2);
    // Newest first: the catch-up fire (later timestamp) leads and is tagged.
    expect(items[0]!.textContent).toContain('late');
    expect(items[1]!.textContent).not.toContain('late');
  });

  it('shows no run-history toggle for a task that has never fired', async () => {
    await mount([baseTask({ runs: [] })]);
    expect(document.querySelector('button[aria-expanded]')).toBeNull();
  });
});

describe('ScheduledTasksDialog run now', () => {
  it('records the run and executes the prompt in the task’s bound session', async () => {
    const onRunPrompt = vi.fn();
    await mount([baseTask({ sessionId: 'sess-9', prompt: 'do it' })], {
      onRunPrompt,
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    // Server-side run record (updates last-run) + client run in the bound session.
    expect(actions.runScheduledTask).toHaveBeenCalledWith('t1');
    expect(onRunPrompt).toHaveBeenCalledWith('do it', 'sess-9');
  });

  it('passes a null sessionId through for an unbound task', async () => {
    const onRunPrompt = vi.fn();
    await mount([baseTask({ sessionId: null, prompt: 'legacy' })], {
      onRunPrompt,
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(onRunPrompt).toHaveBeenCalledWith('legacy', null);
  });

  it('does NOT record the run when the bound session fails to open', async () => {
    // onRunPrompt rejects (session archived/deleted): the prompt never ran, so
    // the run must not be recorded — otherwise history shows a phantom run.
    const onRunPrompt = vi.fn().mockRejectedValue(new Error('archived'));
    const onError = vi.fn();
    await mount([baseTask({ sessionId: 'sess-9', prompt: 'do it' })], {
      onRunPrompt,
      onError,
    });
    click(document.querySelector('[aria-label="Run now"]'));
    await flush();
    expect(onRunPrompt).toHaveBeenCalledWith('do it', 'sess-9');
    expect(actions.runScheduledTask).not.toHaveBeenCalled(); // no phantom record
    expect(onError).toHaveBeenCalled();
  });

  it('serializes run now: a second click while one is pending is ignored', async () => {
    // Hold the first run pending (session still switching), then click again —
    // the button is disabled + the handler guards, so no second prompt/record.
    let resolveRun: (() => void) | undefined;
    const onRunPrompt = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    await mount([baseTask({ sessionId: 'sess-9', prompt: 'do it' })], {
      onRunPrompt,
    });
    const btn = document.querySelector('[aria-label="Run now"]');
    click(btn);
    await flush(); // first run pending → button disabled
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    click(btn); // ignored while pending
    await flush();
    expect(onRunPrompt).toHaveBeenCalledTimes(1);
    resolveRun?.();
    await flush();
    expect(actions.runScheduledTask).toHaveBeenCalledTimes(1); // one record
  });
});

describe('ScheduledTasksDialog far-future countdown', () => {
  it('clamps the reload timer so a months-away schedule cannot overflow setTimeout', async () => {
    const spy = vi.spyOn(window, 'setTimeout');
    try {
      // ~100 days out: the raw delay exceeds setTimeout's 32-bit ceiling, which
      // would fire immediately and spin a reload loop. It must be clamped.
      const farFuture = Date.now() + 100 * 86_400_000;
      await mount([baseTask({ nextRunAt: farFuture })]);
      const delays = spy.mock.calls.map((c) => Number(c[1] ?? 0));
      expect(delays.every((d) => d <= 2_147_483_647)).toBe(true);
      expect(delays).toContain(2_147_483_647); // clamped to the ceiling
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ScheduledTasksDialog view-history (bound session)', () => {
  it('opens the bound session when its history control is clicked', async () => {
    const onOpenSession = vi.fn();
    await mount(
      [
        baseTask({
          sessionId: 'sess-42',
          runs: [{ at: 1_700_000_100_000, kind: 'scheduled' }],
        }),
      ],
      { onOpenSession },
    );
    // A bound task shows a "View history" control (with a run count) that opens
    // its session transcript — not the inline expand toggle.
    const btn = findButton('View history (1)');
    expect(btn).toBeDefined();
    expect(document.querySelector('button[aria-expanded]')).toBeNull();
    click(btn);
    expect(onOpenSession).toHaveBeenCalledWith('sess-42');
  });

  it('shows the view-history control even before the first run (empty state)', async () => {
    const onOpenSession = vi.fn();
    await mount([baseTask({ sessionId: 'sess-42', runs: [] })], {
      onOpenSession,
    });
    // Discoverable even with zero runs — the original "can't find history" pain.
    const btn = findButton('View history');
    expect(btn).toBeDefined();
    click(btn);
    expect(onOpenSession).toHaveBeenCalledWith('sess-42');
  });

  it('falls back to the inline toggle when session opening is not wired', async () => {
    // No onOpenSession (e.g. a minimal embed): a bound task with runs still gets
    // the inline timestamp list rather than a dead open button.
    await mount([
      baseTask({ sessionId: 'sess-42', runs: [{ at: 1_700_000_100_000 }] }),
    ]);
    expect(findButton('View history (1)')).toBeUndefined();
    expect(document.querySelector('button[aria-expanded]')).not.toBeNull();
  });
});

describe('ScheduledTasksDialog next-run countdown', () => {
  it('renders a countdown pill for a task with a next run', async () => {
    // ~3h12m in the future — the hours unit is stable across the test's few ms.
    await mount([
      baseTask({ nextRunAt: Date.now() + 3 * 3_600_000 + 12 * 60_000 }),
    ]);
    const pill = document.querySelector(
      '[data-testid="scheduled-task-next-run"]',
    );
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toMatch(/3h/);
  });

  it('omits the countdown when there is no next run (disabled task)', async () => {
    await mount([baseTask({ enabled: false, nextRunAt: null })]);
    expect(
      document.querySelector('[data-testid="scheduled-task-next-run"]'),
    ).toBeNull();
  });
});
