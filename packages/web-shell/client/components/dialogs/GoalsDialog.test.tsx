// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface MockGoal {
  sessionId: string;
  displayName: string | null;
  condition: string;
  iterations: number;
  setAt: number;
  lastReason?: string;
  hasActivePrompt: boolean;
  snapshot: {
    v: 2;
    activity: 'idle' | 'running' | 'verifying';
    goal: {
      goalId: string;
      revision: number;
      objective: string;
      status: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'complete';
      evidenceCursor: { recordId: string | null };
      turnCount: number;
      activeTimeMs: number;
      turnBudget?: number;
      activeTimeBudgetMs?: number;
      tokensUsed?: number;
      tokenBudget?: number;
      createdAt: number;
      updatedAt: number;
      checkpointStalls?: number;
      lastCheckpointFailure?: string;
      lastReason?: string;
      limitKind?: 'evidence_catalog' | 'checkpoint_request';
    };
  };
}

const { actions } = vi.hoisted(() => ({
  actions: {
    listGoals: vi.fn(),
    clearGoal: vi.fn(),
    controlGoal: vi.fn(),
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { GoalsDialog } = await import('./GoalsDialog');
const { I18nProvider } = await import('../../i18n');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

/** Compose a budget progressbar's accessible name the way the browser does:
 * aria-labelledby concatenates the referenced nodes' text with spaces. The
 * name must be the rendered label + figure themselves, not a duplicated
 * aria-label string. */
function barName(testid: string): string {
  const bar = document.querySelector(`[data-testid="${testid}"]`);
  if (!bar) throw new Error(`bar not found: ${testid}`);
  // The name must come from the referenced visible nodes, not a duplicated
  // aria-label — a regression back to aria-label has to red this helper.
  expect(bar.hasAttribute('aria-label')).toBe(false);
  const ids = (bar.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean);
  expect(ids).toHaveLength(2);
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** Set the condition textarea the way React's onChange expects. */
function setTextarea(value: string) {
  const textarea = document.querySelector('textarea');
  if (!textarea) throw new Error('textarea not found');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function mount(
  goals: MockGoal[],
  opts: {
    onCreateGoal?: (
      condition: string,
      workspaceCwd?: string,
    ) => boolean | void | Promise<boolean | void>;
    onOpenSession?: (sessionId: string, workspaceCwd?: string) => void;
    onError?: (error: unknown, message: string) => void;
    droppedCount?: number;
    workspaces?: Array<{
      id: string;
      cwd: string;
      primary: boolean;
      trusted: boolean;
      displayName?: string;
      ssh?: { host: string; port?: number; directory: string };
    }>;
    lockedWorkspace?: {
      id: string;
      cwd: string;
      primary: boolean;
      trusted: boolean;
      displayName?: string;
    };
    defaultWorkspaceCwd?: string;
    /** Per-workspace listGoals responses, keyed by the action id the dialog
     * passes (undefined → '' for the primary's unqualified route). */
    listGoalsByWorkspace?: Record<
      string,
      { goals: MockGoal[]; droppedCount: number }
    >;
    /** Full control of the listGoals mock (e.g. rejections on the mount
     * load); takes precedence over the other two shapes. */
    listGoalsImpl?: (workspaceId?: string) => Promise<{
      goals: MockGoal[];
      droppedCount: number;
    }>;
  } = {},
) {
  if (opts.listGoalsImpl) {
    actions.listGoals.mockImplementation(opts.listGoalsImpl);
  } else if (opts.listGoalsByWorkspace) {
    const byWorkspace = opts.listGoalsByWorkspace;
    actions.listGoals.mockImplementation(async (workspaceId?: string) =>
      Promise.resolve(
        byWorkspace[workspaceId ?? ''] ?? {
          goals: [],
          droppedCount: 0,
        },
      ),
    );
  } else {
    actions.listGoals.mockResolvedValue({
      goals,
      droppedCount: opts.droppedCount ?? 0,
    });
  }
  actions.clearGoal.mockResolvedValue({ cleared: true });
  actions.controlGoal.mockResolvedValue({
    snapshot: { v: 2, activity: 'idle', goal: null },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <GoalsDialog
          onCreateGoal={opts.onCreateGoal ?? vi.fn()}
          onOpenSession={opts.onOpenSession ?? vi.fn()}
          onError={opts.onError ?? vi.fn()}
          {...(opts.workspaces ? { workspaces: opts.workspaces } : {})}
          {...(opts.lockedWorkspace
            ? { lockedWorkspace: opts.lockedWorkspace }
            : {})}
          {...(opts.defaultWorkspaceCwd !== undefined
            ? { defaultWorkspaceCwd: opts.defaultWorkspaceCwd }
            : {})}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

const baseGoal = (over: Partial<MockGoal> = {}): MockGoal => {
  const setAt = over.setAt ?? Date.now() - 5000;
  const condition = over.condition ?? 'all tests pass';
  const iterations = over.iterations ?? 0;
  const lastReason = over.lastReason;
  const hasActivePrompt = over.hasActivePrompt ?? false;
  return {
    sessionId: 'sess-1',
    displayName: 'fix-ci',
    condition,
    iterations,
    setAt,
    hasActivePrompt,
    ...over,
    snapshot: over.snapshot ?? {
      v: 2,
      activity: hasActivePrompt ? 'running' : 'idle',
      goal: {
        goalId: 'goal-1',
        revision: 1,
        objective: condition,
        status: 'active',
        evidenceCursor: { recordId: 'cursor-1' },
        turnCount: iterations,
        activeTimeMs: 0,
        createdAt: setAt,
        updatedAt: setAt,
        ...(lastReason ? { lastReason } : {}),
      },
    },
  };
};

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  // Unconditionally, not just at the end of each fake-timer test: a failing
  // assertion skips the inline restore, and fake timers would then leak into
  // every test after it as unrelated-looking hangs.
  vi.useRealTimers();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('GoalsDialog', () => {
  it('shows the empty state when no goal is active', async () => {
    await mount([]);
    expect(document.body.textContent).toContain('No active goals');
  });

  it('warns that the list is incomplete when sessions could not be probed', async () => {
    // Otherwise a brownout is indistinguishable from an empty workspace, and
    // the user re-creates goals that are already running.
    await mount([], { droppedCount: 2 });

    expect(
      document.querySelector('[data-testid="goals-dropped"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      '2 sessions could not be reached',
    );
  });

  it('shows no degradation notice when every session was probed', async () => {
    await mount([baseGoal()]);
    expect(document.querySelector('[data-testid="goals-dropped"]')).toBeNull();
  });

  const withSpend = (over: Partial<MockGoal['snapshot']['goal']>): MockGoal => {
    const base = baseGoal();
    return {
      ...base,
      snapshot: {
        ...base.snapshot,
        goal: { ...base.snapshot.goal, ...over },
      },
    };
  };

  it('shows turn and active-time budgets on stopped Goals', async () => {
    await mount([
      withSpend({
        status: 'paused',
        turnCount: 3,
        turnBudget: 20,
        activeTimeMs: 723_000,
        activeTimeBudgetMs: 1_800_000,
      }),
    ]);
    // Armed budgets state their figures once, in the progress row; the
    // matching footer cells are suppressed so the card never repeats them.
    expect(barName('goal-budget-turns')).toBe('Turns 3 / 20 turns');
    expect(barName('goal-budget-time')).toBe('Active time 12m 3s / 30m 0s');
    expect(document.querySelector('[data-testid="goal-turns"]')).toBeNull();
    expect(document.querySelector('[data-testid="goal-elapsed"]')).toBeNull();
  });

  it('keeps usage without budgets unchanged', async () => {
    await mount([
      withSpend({ status: 'paused', turnCount: 1, activeTimeMs: 723_000 }),
    ]);
    expect(
      document.querySelector('[data-testid="goal-turns"]')?.textContent,
    ).toBe('1 turn');
    expect(
      document.querySelector('[data-testid="goal-elapsed"]')?.textContent,
    ).toBe('12m 3s');
  });

  it('renders zero-progress rows for armed budgets before any spend', async () => {
    await mount([
      withSpend({
        status: 'paused',
        turnCount: 0,
        turnBudget: 20,
        activeTimeMs: 0,
        activeTimeBudgetMs: 1_800_000,
      }),
    ]);
    expect(
      document
        .querySelector('[data-testid="goal-budget-turns"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('0');
    expect(
      document
        .querySelector('[data-testid="goal-budget-time"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('0');
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="goal-budget-turns"] > div',
      )?.style.width,
    ).toBe('0%');
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="goal-budget-time"] > div',
      )?.style.width,
    ).toBe('0%');
    expect(document.querySelector('[data-testid="goal-turns"]')).toBeNull();
    expect(document.querySelector('[data-testid="goal-elapsed"]')).toBeNull();
  });

  it('shows spend against the budget once a turn has billed', async () => {
    await mount([withSpend({ tokensUsed: 1_234, tokenBudget: 30_000_000 })]);

    expect(barName('goal-budget-tokens')).toBe('Tokens 1.2k / 30.0M tokens');
    expect(document.querySelector('[data-testid="goal-tokens"]')).toBeNull();
  });

  it('shows spend alone when the Goal has no budget', async () => {
    await mount([withSpend({ tokensUsed: 1_234 })]);

    expect(
      document.querySelector('[data-testid="goal-tokens"]')?.textContent,
    ).toBe('1.2k tokens');
  });

  it('renders a zero token row when a budget is armed but nothing billed', async () => {
    await mount([withSpend({ tokensUsed: 0, tokenBudget: 30_000_000 })]);

    expect(
      document
        .querySelector('[data-testid="goal-budget-tokens"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('0');
    expect(document.querySelector('[data-testid="goal-tokens"]')).toBeNull();
  });

  it('shows nothing for a daemon that does not report spend', async () => {
    // An older daemon's snapshot carries neither field.
    await mount([baseGoal()]);

    expect(document.querySelector('[data-testid="goal-tokens"]')).toBeNull();
  });

  describe('budget progress bars', () => {
    it('renders a bar for each armed budget', async () => {
      await mount([
        withSpend({
          status: 'paused',
          turnCount: 3,
          turnBudget: 20,
          tokensUsed: 5_000_000,
          tokenBudget: 20_000_000,
          activeTimeMs: 600_000,
          activeTimeBudgetMs: 1_800_000,
        }),
      ]);

      const turns = document.querySelector('[data-testid="goal-budget-turns"]');
      const tokens = document.querySelector(
        '[data-testid="goal-budget-tokens"]',
      );
      const time = document.querySelector('[data-testid="goal-budget-time"]');
      expect(turns?.getAttribute('role')).toBe('progressbar');
      expect(turns?.getAttribute('aria-valuemin')).toBe('0');
      expect(turns?.getAttribute('aria-valuemax')).toBe('100');
      expect(turns?.getAttribute('aria-valuenow')).toBe('15');
      expect(tokens?.getAttribute('aria-valuenow')).toBe('25');
      expect(time?.getAttribute('aria-valuenow')).toBe('33');
      expect(barName('goal-budget-turns')).toBe('Turns 3 / 20 turns');
      expect(barName('goal-budget-tokens')).toBe('Tokens 5.0M / 20.0M tokens');
      expect(barName('goal-budget-time')).toBe('Active time 10m 0s / 30m 0s');
      // The inline width is the visual readout; aria alone would stay green
      // with every bar rendered empty or full. jsdom does no layout, so pin
      // the inline style, not a computed pixel width.
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="goal-budget-turns"] > div',
        )?.style.width,
      ).toBe('15%');
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="goal-budget-tokens"] > div',
        )?.style.width,
      ).toBe('25%');
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="goal-budget-time"] > div',
        )?.style.width,
      ).toBe('33%');
    });

    it("states an armed budget's figures exactly once on the card", async () => {
      // Removing the footer suppression must turn this red: the row and the
      // footer would both print the same localised figure. The footer-absence
      // assertion already catches "row deleted, footer took over"; the row
      // existence + row-carries-figure assertions additionally catch the
      // figure relocating outside the row (e.g. into the card header) or the
      // row rendering empty while the figure moves elsewhere.
      await mount([withSpend({ turnCount: 3, turnBudget: 20 })]);

      const card = document.querySelector('[role="listitem"]')!;
      const row = card.querySelector('[data-testid="goal-budget-turns"]');
      expect(row).not.toBeNull();
      const rowText = row!.closest('[class*="budgetRow"]')?.textContent ?? '';
      expect(rowText).toContain('3 / 20 turns');
      const occurrences =
        (card.textContent ?? '').split('3 / 20 turns').length - 1;
      expect(occurrences).toBe(1);
      expect(document.querySelector('[data-testid="goal-turns"]')).toBeNull();
    });

    it('suppresses only the armed budgets footer cells, not the rest', async () => {
      // The extremes (all armed / none armed) cannot witness a suppression
      // predicate wired to the wrong budget: a mixed goal must hide exactly
      // the turns cell and keep the unarmed tokens and time figures.
      await mount([
        withSpend({
          status: 'paused',
          turnCount: 3,
          turnBudget: 20,
          tokensUsed: 1_234,
          activeTimeMs: 723_000,
        }),
      ]);

      expect(
        document.querySelector('[data-testid="goal-budget-turns"]'),
      ).not.toBeNull();
      expect(document.querySelector('[data-testid="goal-turns"]')).toBeNull();
      expect(
        document.querySelector('[data-testid="goal-budget-tokens"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="goal-tokens"]')?.textContent,
      ).toBe('1.2k tokens');
      expect(
        document.querySelector('[data-testid="goal-budget-time"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="goal-elapsed"]')?.textContent,
      ).toBe('12m 3s');
    });

    it('renders no bars when no budget is armed', async () => {
      await mount([baseGoal()]);

      expect(
        document.querySelector('[data-testid="goal-budget-turns"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="goal-budget-tokens"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="goal-budget-time"]'),
      ).toBeNull();
    });

    it('skips the token bar when the daemon reports no spend', async () => {
      // A budget without a usage figure cannot attest zero spend.
      await mount([withSpend({ tokenBudget: 20_000_000 })]);

      expect(
        document.querySelector('[data-testid="goal-budget-tokens"]'),
      ).toBeNull();
    });

    it('clamps a spent budget to a full bar', async () => {
      await mount([
        withSpend({ status: 'usage_limited', turnCount: 25, turnBudget: 20 }),
      ]);

      expect(
        document
          .querySelector('[data-testid="goal-budget-turns"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('100');
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="goal-budget-turns"] > div',
        )?.style.width,
      ).toBe('100%');
    });

    it('tones the fill by lifecycle state', async () => {
      await mount([
        withSpend({ status: 'paused', turnCount: 3, turnBudget: 20 }),
      ]);

      expect(
        document
          .querySelector('[data-testid="goal-budget-turns"] > div')
          ?.getAttribute('data-status'),
      ).toBe('attention');
    });

    it('tones the fill running for an active goal', async () => {
      await mount([
        withSpend({ status: 'active', turnCount: 3, turnBudget: 20 }),
      ]);

      expect(
        document
          .querySelector('[data-testid="goal-budget-turns"] > div')
          ?.getAttribute('data-status'),
      ).toBe('running');
    });

    it('advances the active-time bar on the tick', async () => {
      vi.useFakeTimers();
      const goal = baseGoal({ hasActivePrompt: true });
      goal.snapshot.goal.activeTimeMs = 60_000;
      goal.snapshot.goal.activeTimeBudgetMs = 1_800_000;
      goal.snapshot.goal.updatedAt = Date.now();
      await mount([goal]);

      const valueNow = () =>
        Number(
          document
            .querySelector('[data-testid="goal-budget-time"]')
            ?.getAttribute('aria-valuenow'),
        );
      const figure = () =>
        document.getElementById('sess-1-budget-time-value')?.textContent;
      const before = valueNow();
      expect(figure()).toBe('1m 0s / 30m 0s');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(valueNow()).toBeGreaterThan(before);
      // The figure beside the bar must advance with it: a tick that moved
      // only the fill would leave the row's two readouts disagreeing.
      expect(figure()).toBe('3m 0s / 30m 0s');
      vi.useRealTimers();
    });

    it('ticks the active-time bar while the session is between turns', async () => {
      // The timer gates on the goal's STATUS, not the session's activity:
      // an active goal whose session is idle between turns still accrues
      // active time. A gate rewritten to `activity !== 'idle'` survives the
      // running-activity case above and dies here.
      vi.useFakeTimers();
      const goal = baseGoal({ hasActivePrompt: false });
      goal.snapshot.goal.activeTimeMs = 60_000;
      goal.snapshot.goal.activeTimeBudgetMs = 1_800_000;
      goal.snapshot.goal.updatedAt = Date.now();
      await mount([goal]);

      const valueNow = () =>
        Number(
          document
            .querySelector('[data-testid="goal-budget-time"]')
            ?.getAttribute('aria-valuenow'),
        );
      const before = valueNow();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(valueNow()).toBeGreaterThan(before);
      vi.useRealTimers();
    });

    it('rounds the bar to the nearest percent while the figure stays exact', async () => {
      // 1_794_000 / 1_800_000 = 99.67%: the bar rounds to full (a floor
      // mutant reads 99) while the figure keeps attesting the remaining
      // headroom — the two readouts serve different purposes.
      await mount([
        withSpend({
          status: 'paused',
          activeTimeMs: 1_794_000,
          activeTimeBudgetMs: 1_800_000,
        }),
      ]);

      expect(
        document
          .querySelector('[data-testid="goal-budget-time"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('100');
      expect(
        document.querySelector<HTMLElement>(
          '[data-testid="goal-budget-time"] > div',
        )?.style.width,
      ).toBe('100%');
      expect(barName('goal-budget-time')).toBe('Active time 29m 54s / 30m 0s');
    });

    it('keeps budget label ids unique across cards and scoped to each card', async () => {
      const first = baseGoal();
      first.snapshot.goal.turnCount = 1;
      first.snapshot.goal.turnBudget = 20;
      const second = baseGoal({ sessionId: 'sess-2', displayName: 'two' });
      second.snapshot.goal.goalId = 'goal-2';
      second.snapshot.goal.turnCount = 2;
      second.snapshot.goal.turnBudget = 30;
      await mount([first, second]);

      const bars = Array.from(
        document.querySelectorAll('[role="progressbar"]'),
      );
      expect(bars).toHaveLength(2);
      const ids = bars.flatMap((bar) =>
        (bar.getAttribute('aria-labelledby') ?? '').split(/\s+/),
      );
      expect(new Set(ids).size).toBe(ids.length);
      for (const bar of bars) {
        const card = bar.closest('[role="listitem"]')!;
        for (const id of (bar.getAttribute('aria-labelledby') ?? '').split(
          /\s+/,
        )) {
          expect(card.contains(document.getElementById(id))).toBe(true);
        }
      }
    });
  });

  const stopped = (
    over: Partial<MockGoal['snapshot']['goal']> = {},
  ): MockGoal => {
    const base = baseGoal();
    return {
      ...base,
      snapshot: {
        ...base.snapshot,
        goal: { ...base.snapshot.goal, status: 'usage_limited', ...over },
      },
    };
  };

  const resumeButton = () =>
    document.querySelector('[aria-label="Resume goal"]');

  it('offers resume for an ordinary usage-limited stop', async () => {
    // Reverse control for the two tests below: operational stops carry prose
    // in `lastReason` too and the reducer resumes them, so the evidence gate
    // must not widen into "any usage_limited Goal with a reason".
    await mount([stopped({ lastReason: 'The provider rate-limited us.' })]);
    expect(resumeButton()).not.toBeNull();
  });

  it('offers resume for an evidence-limited Goal', async () => {
    await mount([stopped({ limitKind: 'evidence_catalog' })]);
    expect(resumeButton()).not.toBeNull();
  });

  it('offers resume for a Goal evidence-limited before `limitKind` existed', async () => {
    // The sentinel prose shipped before the `limitKind` field did: a Goal
    // persisted in that window restores as `usage_limited` with no
    // `limitKind`. The dialog does not parse the prose -- resumability is
    // decided by status alone -- so one representative sentinel is enough.
    await mount([
      stopped({
        lastReason:
          'The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.',
      }),
    ]);
    expect(resumeButton()).not.toBeNull();
  });

  const checkpointLine = () =>
    document.querySelector('[data-testid="goal-checkpoint"]')?.textContent;

  it('hides a stall-free failure once the Goal stopped for another reason', async () => {
    await mount([stopped({ lastCheckpointFailure: 'Error: provider failed' })]);

    expect(checkpointLine()).toBeUndefined();
  });

  it('reads a diagnostic made only of control characters as no failure, as core does', async () => {
    // Sanitizing escapes a lone control character rather than removing it, so
    // the gate has to read the raw value.
    await mount([withSpend({ lastCheckpointFailure: '\r' })]);

    expect(checkpointLine()).toBeUndefined();
  });

  it('hides checkpoint health on a completed Goal that still carries it', async () => {
    await mount([
      withSpend({
        status: 'complete',
        checkpointStalls: 3,
        lastCheckpointFailure: 'Error: provider failed',
      }),
    ]);

    expect(checkpointLine()).toBeUndefined();
  });

  it('shows no checkpoint line, even for a snapshot an older daemon filled in', async () => {
    // Goals no longer run evidence checkpoints; a daemon that predates that
    // can still send the two fields, and they are not drawn.
    await mount([
      withSpend({
        checkpointStalls: 2,
        lastCheckpointFailure: 'Error: provider failed',
      }),
    ]);

    expect(checkpointLine()).toBeUndefined();
    expect(document.body.textContent).not.toContain('provider failed');
  });

  it('renders a goal with its condition, turn count and judge verdict', async () => {
    await mount([
      baseGoal({ iterations: 3, lastReason: 'two tests still fail' }),
    ]);

    const text = document.body.textContent ?? '';
    expect(text).toContain('all tests pass');
    expect(text).toContain('3 turns');
    expect(text).toContain('two tests still fail');
    expect(text).toContain('fix-ci');
  });

  it('says "not yet evaluated" before the first judge turn', async () => {
    await mount([baseGoal({ iterations: 0 })]);
    expect(document.body.textContent).toContain('not yet evaluated');
  });

  it('distinguishes a working goal from a waiting one', async () => {
    await mount([baseGoal({ hasActivePrompt: true })]);
    expect(document.body.textContent).toContain('Working');

    act(() => root?.unmount());
    container?.remove();
    await mount([baseGoal({ hasActivePrompt: false })]);
    expect(document.body.textContent).toContain('Waiting');
  });

  it('falls back to the session id when the session has no name', async () => {
    await mount([baseGoal({ displayName: null, sessionId: 'abc-123' })]);
    expect(findButton('abc-123')).toBeDefined();
  });

  it('opens the goal session when its label is clicked', async () => {
    const onOpenSession = vi.fn();
    await mount([baseGoal()], { onOpenSession });

    click(findButton('fix-ci'));

    expect(onOpenSession).toHaveBeenCalledWith('sess-1', undefined);
  });

  it('opens the goal session from the header action', async () => {
    const onOpenSession = vi.fn();
    await mount([baseGoal()], { onOpenSession });

    click(document.querySelector('[data-testid="goal-open-session"]'));

    expect(onOpenSession).toHaveBeenCalledWith('sess-1', undefined);
  });

  it('renders the session link as a labeled navigation affordance', async () => {
    await mount([baseGoal()]);

    const link = document.querySelector('[data-testid="goal-session-link"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('fix-ci');
    // Message icon + arrow icon frame the name so it reads as a jump, not a
    // label; the grey text-only shape was indistinguishable from the meta.
    expect(link!.querySelectorAll('svg')).toHaveLength(2);
  });

  it('names both jump affordances with the action and the session', async () => {
    // The header action is icon-only, so its accessible name is the only
    // thing a screen reader gets; the footer link must carry the same.
    await mount([baseGoal()]);

    const expected = "Open this goal's session: fix-ci";
    expect(
      document
        .querySelector('[data-testid="goal-open-session"]')
        ?.getAttribute('aria-label'),
    ).toBe(expected);
    expect(
      document
        .querySelector('[data-testid="goal-session-link"]')
        ?.getAttribute('aria-label'),
    ).toBe(expected);
  });

  it('keeps the header session action enabled while a control is in flight', async () => {
    // Navigation is not a control: the busy gate that locks edit/pause/clear
    // must never lock the jump to the session. Gating it would strand the
    // user on the Goals page for the whole duration of a slow control.
    const onOpenSession = vi.fn();
    await mount([baseGoal()], { onOpenSession });
    let release: (() => void) | undefined;
    actions.controlGoal.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ snapshot: { v: 2, activity: 'idle', goal: null } });
        }),
    );

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear goal"]',
      )?.disabled,
    ).toBe(true);

    const jump = document.querySelector<HTMLButtonElement>(
      '[data-testid="goal-open-session"]',
    );
    expect(jump?.disabled).toBe(false);
    click(jump);
    expect(onOpenSession).toHaveBeenCalledWith('sess-1', undefined);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await flush();
  });

  it('opens the goal session in its tagged workspace from the header action', async () => {
    const onOpenSession = vi.fn();
    await mount([], {
      workspaces: [
        { id: 'ws-1', cwd: '/w-primary', primary: true, trusted: true },
        { id: 'ws-2', cwd: '/w-secondary', primary: false, trusted: true },
      ],
      // The goal lives in the SECONDARY workspace: a primary-tagged goal
      // cannot witness per-goal routing, since the primary cwd is also the
      // default the handler would fall back to.
      listGoalsByWorkspace: {
        '': { goals: [], droppedCount: 0 },
        'ws-2': { goals: [baseGoal()], droppedCount: 0 },
      },
      onOpenSession,
    });

    click(document.querySelector('[data-testid="goal-open-session"]'));

    expect(onOpenSession).toHaveBeenCalledWith('sess-1', '/w-secondary');
  });

  it('keeps the footer session link enabled while a control is in flight', async () => {
    // Same navigation exemption as the header action, pinned on the footer
    // entry too: a busy gate added to only one of the two would otherwise
    // ship undetected.
    const onOpenSession = vi.fn();
    await mount([baseGoal()], { onOpenSession });
    let release: (() => void) | undefined;
    actions.controlGoal.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ snapshot: { v: 2, activity: 'idle', goal: null } });
        }),
    );

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();
    expect(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear goal"]',
      )?.disabled,
    ).toBe(true);

    const link = document.querySelector<HTMLButtonElement>(
      '[data-testid="goal-session-link"]',
    );
    expect(link?.disabled).toBe(false);
    click(link);
    expect(onOpenSession).toHaveBeenCalledWith('sess-1', undefined);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await flush();
  });

  it('opens the session of a completed goal from both jump affordances', async () => {
    // The listings filter completed goals today, but the card itself must
    // still navigate if one is present: completion ends the controls, not
    // the ability to read the goal's transcript.
    const onOpenSession = vi.fn();
    const completed = baseGoal();
    completed.snapshot.goal.status = 'complete';
    await mount([completed], { onOpenSession });

    click(document.querySelector('[data-testid="goal-open-session"]'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-1', undefined);
    click(document.querySelector('[data-testid="goal-session-link"]'));
    expect(onOpenSession).toHaveBeenCalledTimes(2);
  });

  it('scopes the header and footer jumps to the card they sit on', async () => {
    // Clicking only the list's first card cannot witness per-item scoping:
    // a handler wired to a fixed row (or the wrong closure variable) would
    // still pass. Click the SECOND card's affordances instead.
    const onOpenSession = vi.fn();
    const first = baseGoal();
    const second = baseGoal({
      sessionId: 'sess-2',
      displayName: 'second-goal',
      setAt: Date.now() - 10_000,
    });
    second.snapshot.goal.goalId = 'goal-2';
    await mount([first, second], { onOpenSession });

    const cards = document.querySelectorAll('[role="listitem"]');
    expect(cards).toHaveLength(2);
    const secondCard = cards[1];
    click(secondCard.querySelector('[data-testid="goal-open-session"]'));
    expect(onOpenSession).toHaveBeenLastCalledWith('sess-2', undefined);
    click(secondCard.querySelector('[data-testid="goal-session-link"]'));
    expect(onOpenSession).toHaveBeenLastCalledWith('sess-2', undefined);
    expect(onOpenSession).toHaveBeenCalledTimes(2);
  });

  it('tones the status pill by lifecycle state', async () => {
    const statuses = [
      'active',
      'paused',
      'blocked',
      'usage_limited',
      'complete',
    ] as const;
    const tones = ['running', 'attention', 'attention', 'attention', 'done'];
    // Distinct descending setAt values keep the merged list in this order.
    await mount(
      statuses.map((status, index) => {
        const goal = baseGoal({
          sessionId: `sess-${index}`,
          setAt: 1000 - index,
        });
        return {
          ...goal,
          snapshot: {
            ...goal.snapshot,
            goal: { ...goal.snapshot.goal, status },
          },
        };
      }),
    );

    const pills = document.querySelectorAll('[data-testid="goal-status"]');
    expect(pills).toHaveLength(statuses.length);
    statuses.forEach((_, index) => {
      expect(pills[index].getAttribute('data-status')).toBe(tones[index]);
    });
  });

  it('clears a goal immediately and reloads the list', async () => {
    await mount([baseGoal()]);
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(actions.controlGoal).toHaveBeenCalledWith('sess-1', {
      action: 'clear',
      expectedGoalId: 'goal-1',
      expectedRevision: 1,
    });
    expect(document.body.textContent).toContain('No active goals');
  });

  it('does not require confirmation to clear', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await mount([baseGoal()]);

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();

    expect(actions.controlGoal).toHaveBeenCalled();
  });

  it('surfaces a clear failure through onError', async () => {
    const onError = vi.fn();
    await mount([baseGoal()], { onError });
    actions.controlGoal.mockRejectedValue(new Error('session is gone'));

    click(document.querySelector('button[aria-label="Clear goal"]'));
    await flush();

    expect(onError).toHaveBeenCalled();
  });

  it('reloads the list when Refresh is clicked', async () => {
    // The poll is on a 10s lane, so Refresh is the only way to see a goal you
    // just set from another window without waiting.
    await mount([]);
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    actions.listGoals.mockResolvedValue({
      goals: [baseGoal({ condition: 'freshly appeared' })],
      droppedCount: 0,
    });
    click(findButton('Refresh'));
    await flush();

    expect(actions.listGoals).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('freshly appeared');
  });

  it("disables a goal's clear button while its clear is in flight", async () => {
    // Without this, a double-click fires two concurrent clears at the same
    // session — the second racing a goal that is already gone.
    await mount([baseGoal()]);
    // After mount: the helper itself stubs clearGoal with a resolved value.
    let release: (() => void) | undefined;
    actions.controlGoal.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ cleared: true });
        }),
    );

    const clearButton = () =>
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear goal"]',
      );
    expect(clearButton()?.disabled).toBe(false);

    click(clearButton());
    await flush();

    expect(actions.controlGoal).toHaveBeenCalledTimes(1);
    expect(clearButton()?.disabled).toBe(true);

    // A second click while the first is still in flight must do nothing.
    click(clearButton());
    await flush();
    expect(actions.controlGoal).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await flush();
  });

  it('keeps independent sessions busy until their own controls settle', async () => {
    const first = baseGoal({ sessionId: 'sess-1', displayName: 'one' });
    const second = baseGoal({
      sessionId: 'sess-2',
      displayName: 'two',
      snapshot: {
        ...baseGoal().snapshot,
        goal: {
          ...baseGoal().snapshot.goal,
          goalId: 'goal-2',
        },
      },
    });
    await mount([first, second]);
    const releases = new Map<string, () => void>();
    actions.controlGoal.mockImplementation(
      (sessionId: string) =>
        new Promise((resolve) => {
          releases.set(sessionId, () =>
            resolve({ snapshot: { v: 2, activity: 'idle', goal: null } }),
          );
        }),
    );
    const cards = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="listitem"]'));
    const clear = (index: number) =>
      cards()[index]?.querySelector<HTMLButtonElement>(
        'button[aria-label="Clear goal"]',
      );

    click(clear(0));
    click(clear(1));
    await flush();
    expect(actions.controlGoal).toHaveBeenCalledTimes(2);
    expect(clear(0)?.disabled).toBe(true);
    expect(clear(1)?.disabled).toBe(true);

    await act(async () => {
      releases.get('sess-1')?.();
      await Promise.resolve();
    });
    expect(clear(0)?.disabled).toBe(false);
    expect(clear(1)?.disabled).toBe(true);

    await act(async () => {
      releases.get('sess-2')?.();
      await Promise.resolve();
    });
  });

  it('rejects an empty condition instead of submitting it', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Enter a condition');
    // Announced, not just painted: a screen-reader user gets no other signal
    // that the submit was rejected, and would believe the goal was created.
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Enter a condition');
  });

  it('accepts a condition far longer than the old 4,000-char cap', async () => {
    // `/goal` takes a condition of any length (#6665). Rejecting one here that
    // the daemon would accept splits the two surfaces, and the textarea used to
    // silently truncate at `maxLength` before the user could even submit it.
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    const condition = 'x'.repeat(10_000);
    setTextarea(condition);
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith(condition, undefined);
  });

  it('accepts a clear word as a literal objective in the create form', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('  Clear  ');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('Clear', undefined);
  });

  it('discards the typed condition when the form is cancelled', async () => {
    // Cancel is the only way out of the form without submitting; if its wiring
    // breaks there is no escape but a page reload.
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Cancel'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();

    // Re-opening must not resurrect the abandoned condition.
    click(findButton('New goal'));
    expect(document.querySelector('textarea')?.value).toBe('');
  });

  it('submits a trimmed condition and closes the form', async () => {
    const onCreateGoal = vi.fn();
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('  ship it  ');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it', undefined);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('cannot be dismissed while a submit is in flight', async () => {
    // The submit outlives the form it was started from: its success arm calls
    // resetForm() and its failure arm renders an error, both against whatever
    // form is open when it settles. Closing mid-flight would hand those to the
    // next goal's form and lose the objective typed into it.
    let settleCreate: ((created: boolean) => void) | undefined;
    const onCreateGoal = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleCreate = resolve;
        }),
    );
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await flush();
    expect(document.querySelector('textarea')?.value).toBe('ship it');

    await act(async () => {
      settleCreate?.(true);
      await flush();
    });
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('submits an edit with the latest polled goal revision', async () => {
    await mount([baseGoal()]);

    click(document.querySelector('button[aria-label="Edit goal"]'));
    setTextarea('updated objective');
    actions.listGoals.mockResolvedValue({
      goals: [
        baseGoal({
          snapshot: {
            ...baseGoal().snapshot,
            goal: { ...baseGoal().snapshot.goal, revision: 2 },
          },
        }),
      ],
      droppedCount: 0,
    });
    click(findButton('Refresh'));
    await flush();

    click(findButton('Save'));
    await flush();

    expect(actions.controlGoal).toHaveBeenCalledWith('sess-1', {
      action: 'edit',
      objective: 'updated objective',
      expectedGoalId: 'goal-1',
      expectedRevision: 2,
    });
  });

  it('offers no Edit control for a completed goal', async () => {
    // The reducer rejects `edit` on a completed Goal and completion does not
    // bump the revision, so the version check passes and the edit dead-ends in
    // an error toast — the affordance has to disappear with the capability.
    await mount([
      baseGoal({
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-1',
            revision: 4,
            objective: 'all tests pass',
            status: 'complete',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 2,
            activeTimeMs: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      }),
    ]);

    expect(document.querySelector('button[aria-label="Edit goal"]')).toBeNull();
  });

  it('reports an edit for a vanished session as unavailable', async () => {
    // Falling back to the stale snapshot would compare it against itself and
    // send a stale expectedRevision, surfacing the daemon's raw conflict error
    // instead of the friendly copy this path was written for.
    await mount([baseGoal()]);

    click(document.querySelector('button[aria-label="Edit goal"]'));
    setTextarea('updated objective');
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });
    click(findButton('Refresh'));
    await flush();

    click(findButton('Save'));
    await flush();

    expect(actions.controlGoal).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'no longer available',
    );
  });

  it('rejects an edit when polling finds a replacement goal', async () => {
    await mount([baseGoal()]);

    click(document.querySelector('button[aria-label="Edit goal"]'));
    setTextarea('text meant for the old goal');
    actions.listGoals.mockResolvedValue({
      goals: [
        baseGoal({
          snapshot: {
            ...baseGoal().snapshot,
            goal: {
              ...baseGoal().snapshot.goal,
              goalId: 'goal-2',
              revision: 1,
            },
          },
        }),
      ],
      droppedCount: 0,
    });
    click(findButton('Refresh'));
    await flush();

    click(findButton('Save'));
    await flush();

    expect(actions.controlGoal).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'no longer available',
    );
  });

  it('never lets a slow /goals poll overlap itself', async () => {
    // `GET /goals` fans out one probe per live session and a wedged child can
    // hold it for the bridge's ext-method timeout, which is the same order as
    // the poll interval. A fixed setInterval would stack fan-outs, and the
    // action timeout rejects the wait without aborting the request.
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    actions.listGoals.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ goals: [], droppedCount: 0 });
        }),
    );

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    // The mount load is in flight and never settles.
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    // Well past several intervals: still exactly one request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    // Once it settles, the next poll is scheduled one interval later.
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('stops polling once unmounted', async () => {
    vi.useFakeTimers();
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterMount = actions.listGoals.mock.calls.length;

    act(() => root?.unmount());
    root = null;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(actions.listGoals).toHaveBeenCalledTimes(afterMount);

    vi.useRealTimers();
  });

  it('routes a creation failure to a toast when the page closed mid-flight', async () => {
    const onError = vi.fn();
    let reject: ((e: Error) => void) | undefined;
    const onCreateGoal = vi.fn(
      () =>
        new Promise<void>((_resolve, rj) => {
          reject = rj;
        }),
    );
    await mount([], { onCreateGoal, onError });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    // Navigating away unmounts the page while the prompt is still in flight;
    // an inline form error would never be seen.
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      reject?.(new Error('daemon says no'));
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalled();
  });

  it('renders the load error and keeps the list usable', async () => {
    actions.listGoals.mockRejectedValue(new Error('daemon unreachable'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(document.body.textContent).toContain('daemon unreachable');
    // The list goes stale on a poll that fails after the page is already up;
    // nothing else on screen changes, so this has to announce itself.
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'daemon unreachable',
    );
  });

  it('drops a stale dropped-session count when the next load fails outright', async () => {
    // The banner describes a partial probe. A hard `GET /goals` failure is a
    // different state, and pinning the old count reports a partial probe that
    // did not happen on this load.
    vi.useFakeTimers();
    actions.listGoals.mockResolvedValue({ goals: [], droppedCount: 2 });
    actions.clearGoal.mockResolvedValue({ cleared: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={vi.fn()}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      document.querySelector('[data-testid="goals-dropped"]'),
    ).not.toBeNull();

    // The next poll reaches nothing at all.
    actions.listGoals.mockRejectedValue(new Error('daemon unreachable'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(document.querySelector('[data-testid="goals-dropped"]')).toBeNull();
    expect(document.body.textContent).toContain('daemon unreachable');
    vi.useRealTimers();
  });

  it('keeps the form open with the condition when creation reports failure', async () => {
    // `onCreateGoal` returning false means no goal was started and the caller
    // already surfaced why. Resetting would close the form and silently throw
    // away what the user typed.
    const onCreateGoal = vi.fn().mockResolvedValue(false);
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it', undefined);
    const textarea = document.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe('ship it');
  });

  it('closes the form when creation resolves with no explicit result', async () => {
    // The common case: a void-returning callback still means success.
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], { onCreateGoal });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(document.querySelector('textarea')).toBeNull();
  });
});

/** Set the workspace select the way React's onChange expects. */
function setSelect(value: string) {
  const select = document.querySelector('select');
  if (!select) throw new Error('select not found');
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('GoalsDialog multi-workspace', () => {
  const primaryWs = {
    id: 'ws-primary',
    cwd: '/w-primary',
    primary: true,
    trusted: true,
  };
  const secondaryWs = {
    id: 'ws-2',
    cwd: '/w-secondary',
    primary: false,
    trusted: true,
    displayName: 'Secondary',
  };
  const untrustedWs = {
    id: 'ws-untrusted',
    cwd: '/w-untrusted',
    primary: false,
    trusted: false,
  };

  it('aggregates goals from every operable workspace and badges each card', async () => {
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsByWorkspace: {
        '': {
          goals: [baseGoal({ sessionId: 'p1', condition: 'primary goal' })],
          droppedCount: 0,
        },
        'ws-2': {
          goals: [
            baseGoal({
              sessionId: 's1',
              condition: 'secondary goal',
              displayName: 'sec-session',
            }),
          ],
          droppedCount: 0,
        },
      },
    });

    expect(actions.listGoals).toHaveBeenCalledWith(undefined);
    expect(actions.listGoals).toHaveBeenCalledWith('ws-2');
    expect(document.body.textContent).toContain('primary goal');
    expect(document.body.textContent).toContain('secondary goal');
    const badges = document.querySelectorAll('[data-testid="goal-workspace"]');
    expect(badges).toHaveLength(2);
    expect(badges[0]!.textContent).toContain('w-primary');
    expect(badges[1]!.textContent).toContain('Secondary');
  });

  it('sorts the merged list newest-first across workspaces', async () => {
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsByWorkspace: {
        '': {
          goals: [
            baseGoal({ sessionId: 'p1', condition: 'older', setAt: 1000 }),
          ],
          droppedCount: 0,
        },
        'ws-2': {
          goals: [
            baseGoal({ sessionId: 's1', condition: 'newer', setAt: 2000 }),
          ],
          droppedCount: 0,
        },
      },
    });

    const titles = Array.from(
      document.querySelectorAll('[role="listitem"]'),
    ).map((card) => card.textContent);
    expect(titles[0]).toContain('newer');
    expect(titles[1]).toContain('older');
  });

  it('excludes an untrusted secondary without requesting its goals', async () => {
    await mount([], {
      workspaces: [primaryWs, secondaryWs, untrustedWs],
      listGoalsByWorkspace: {
        '': { goals: [], droppedCount: 0 },
        'ws-2': { goals: [], droppedCount: 0 },
      },
    });

    expect(actions.listGoals).toHaveBeenCalledWith(undefined);
    expect(actions.listGoals).toHaveBeenCalledWith('ws-2');
    expect(actions.listGoals).not.toHaveBeenCalledWith('ws-untrusted');
  });

  it('keeps the other workspaces goals when one listing fails on first load', async () => {
    // The failure must hit the MOUNT load: if the per-workspace catch were
    // removed, Promise.all would reject and the first paint would render no
    // goals at all (the outer catch only retains a previously loaded list).
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsImpl: async (workspaceId?: string) => {
        if (workspaceId === 'ws-2') throw new Error('secondary unreachable');
        return {
          goals: [baseGoal({ sessionId: 'p1', condition: 'primary goal' })],
          droppedCount: 0,
        };
      },
    });

    expect(document.body.textContent).toContain('primary goal');
    // The error names the workspace so the user knows which project is missing.
    expect(document.body.textContent).toContain(
      'Secondary: secondary unreachable',
    );
  });

  it('keeps the previous list when every workspace listing fails', async () => {
    // A total outage must not erase the page for multi-workspace users only —
    // the single/locked views retain the previous list via the outer catch.
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsByWorkspace: {
        '': {
          goals: [baseGoal({ sessionId: 'p1', condition: 'primary goal' })],
          droppedCount: 0,
        },
        'ws-2': { goals: [], droppedCount: 0 },
      },
    });
    expect(document.body.textContent).toContain('primary goal');

    actions.listGoals.mockRejectedValue(new Error('daemon restarting'));
    click(findButton('Refresh'));
    await flush();

    expect(document.body.textContent).toContain('primary goal');
    expect(document.body.textContent).toContain('daemon restarting');
  });

  it('shows an untrusted primary listing failure instead of dropping it silently', async () => {
    // Narrowing the operable filter to `ws.trusted` would drop the untrusted
    // primary from the fan-out and hide its goals with no error at all.
    const untrustedPrimary = { ...primaryWs, trusted: false };
    await mount([], {
      workspaces: [untrustedPrimary, secondaryWs],
      listGoalsImpl: async (workspaceId?: string) => {
        if (workspaceId === undefined) throw new Error('primary untrusted');
        return { goals: [], droppedCount: 0 };
      },
    });

    expect(actions.listGoals).toHaveBeenCalledWith(undefined);
    expect(document.body.textContent).toContain('primary untrusted');
  });

  it('accounts for skipped untrusted secondaries instead of a bare empty state', async () => {
    await mount([], {
      workspaces: [primaryWs, untrustedWs],
      listGoalsByWorkspace: { '': { goals: [], droppedCount: 0 } },
    });

    const skipped = document.querySelector('[data-testid="goals-skipped"]');
    expect(skipped).not.toBeNull();
    expect(skipped!.textContent).toContain('1');
    expect(document.body.textContent).not.toContain('No active goals');
  });

  it('keeps the empty state in a locked view even when the list carries untrusted secondaries', async () => {
    // The notice only renders in the aggregated view; the empty-state
    // suppression must use the same predicate, or a locked deployment with
    // an untrusted secondary in its capability list renders neither.
    await mount([], {
      workspaces: [primaryWs, untrustedWs],
      lockedWorkspace: primaryWs,
      listGoalsByWorkspace: { '': { goals: [], droppedCount: 0 } },
    });

    expect(document.querySelector('[data-testid="goals-skipped"]')).toBeNull();
    expect(document.body.textContent).toContain('No active goals');
  });

  it('excludes SSH workspaces from the fan-out and the picker, with a notice', async () => {
    // The SSH boundary rejects the qualified goals route with 501, so an SSH
    // workspace can never load; it must be skipped, not polled into a
    // permanent load error.
    const sshWs = {
      id: 'ws-ssh',
      cwd: '/remote/checkout',
      primary: false,
      trusted: true,
      ssh: { host: 'remote.example', directory: '/remote/checkout' },
    };
    await mount([], {
      workspaces: [primaryWs, sshWs],
      listGoalsByWorkspace: { '': { goals: [], droppedCount: 0 } },
    });

    expect(actions.listGoals).toHaveBeenCalledWith(undefined);
    expect(actions.listGoals).not.toHaveBeenCalledWith('ws-ssh');
    const skipped = document.querySelector('[data-testid="goals-skipped"]');
    expect(skipped).not.toBeNull();
    expect(skipped!.textContent).toContain('1');

    click(findButton('New goal'));
    const options = Array.from(document.querySelector('select')!.options).map(
      (o) => o.value,
    );
    expect(options).toEqual(['/w-primary']);
  });

  it('names every failing workspace in the load error', async () => {
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsImpl: async (workspaceId?: string) => {
        if (workspaceId === undefined) throw new Error('primary down');
        throw new Error('secondary down');
      },
    });

    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('primary down');
    expect(alert!.textContent).toContain('secondary down');
  });

  it('disambiguates picker labels when two workspaces share a basename', async () => {
    const checkoutA = {
      id: 'ws-a',
      cwd: '/home/me/work/qwen-code',
      primary: true,
      trusted: true,
    };
    const checkoutB = {
      id: 'ws-b',
      cwd: '/home/me/oss/qwen-code',
      primary: false,
      trusted: true,
    };
    await mount([], {
      workspaces: [checkoutA, checkoutB],
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    const labels = Array.from(document.querySelector('select')!.options).map(
      (o) => o.textContent,
    );
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels[0]).toContain('qwen-code');
    expect(labels[1]).toContain('qwen-code');
  });

  it('sums dropped counts across workspaces', async () => {
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsByWorkspace: {
        '': { goals: [], droppedCount: 1 },
        'ws-2': { goals: [], droppedCount: 2 },
      },
    });

    const degraded = document.querySelector('[data-testid="goals-dropped"]');
    expect(degraded).not.toBeNull();
    expect(degraded!.textContent).toContain('3');
  });

  it('offers a workspace picker defaulting to the selected workspace', async () => {
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      defaultWorkspaceCwd: '/w-secondary',
      onCreateGoal,
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    const select = document.querySelector('select');
    expect(select).not.toBeNull();
    expect(select!.value).toBe('/w-secondary');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual([
      '/w-primary',
      '/w-secondary',
    ]);

    setSelect('/w-primary');
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it', '/w-primary');
  });

  it('falls back to the primary when the default workspace is not operable', async () => {
    // The untrusted workspace must be IN the list so the trust filter in
    // defaultCreateWorkspaceCwd is actually consulted (a cwd absent from the
    // list would fall back under a raw workspaceList.some() too).
    await mount([], {
      workspaces: [primaryWs, secondaryWs, untrustedWs],
      defaultWorkspaceCwd: '/w-untrusted',
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    expect(document.querySelector('select')!.value).toBe('/w-primary');
  });

  it('never offers an untrusted primary as a create target', async () => {
    // The fan-out keeps the untrusted primary so its listing failure stays
    // loud, but the create path refuses it — the picker must not default to
    // a target every submit would reject. Removing the creatable filter reds
    // this case (options and default would include the untrusted primary).
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], {
      workspaces: [{ ...primaryWs, trusted: false }, secondaryWs],
      onCreateGoal,
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    const select = document.querySelector('select');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual([
      '/w-secondary',
    ]);
    expect(select!.value).toBe('/w-secondary');

    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it', '/w-secondary');
  });

  it('refuses the submit with a visible error when no workspace is creatable', async () => {
    // Every registered workspace is untrusted: the form must not submit
    // undefined into the App's silent no-target path — the user gets the
    // declared refusal instead of a dead button. Removing the guard reds
    // this case (onCreateGoal would be called with undefined).
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], {
      workspaces: [{ ...primaryWs, trusted: false }, untrustedWs],
      onCreateGoal,
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'unavailable or untrusted',
    );
  });

  it('refuses the submit when the single advertised workspace is untrusted', async () => {
    // No picker renders in the single-workspace view, but the refusal must
    // still fire: submitting undefined would reach the App's silent
    // no-target path. Narrowing the guard back to isMultiWorkspace reds
    // this case.
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], {
      workspaces: [{ ...primaryWs, trusted: false }],
      onCreateGoal,
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    expect(document.querySelector('select')).toBeNull();
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'unavailable or untrusted',
    );
  });

  it('retires the no-creatable refusal once a creatable target reappears', async () => {
    // The refusal must not outlive its condition: a capabilities refresh
    // that grants trust re-enables the picker, and the stale alert must
    // clear without another submit. Removing the retirement effect reds
    // this case.
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], {
      workspaces: [{ ...primaryWs, trusted: false }, untrustedWs],
      onCreateGoal,
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'unavailable or untrusted',
    );

    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={onCreateGoal}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
            workspaces={[{ ...primaryWs, trusted: false }, secondaryWs]}
          />
        </I18nProvider>,
      );
    });
    await flush();

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('select')!.value).toBe('/w-secondary');
  });

  it('explains the empty picker inline when nothing is creatable', async () => {
    // The disabled empty picker must carry the reason before any submit,
    // not only after a dead-button click.
    await mount([], {
      workspaces: [{ ...primaryWs, trusted: false }, untrustedWs],
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    const hint = document.querySelector('[data-testid="goals-no-creatable"]');
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain('unavailable or untrusted');
    expect(document.querySelector('select')!.disabled).toBe(true);
  });

  it('reconciles a vanished selection with the creatable set for control and submit', async () => {
    // A capabilities refresh can drop the selected workspace while the form
    // stays open. Both the rendered select and the submitted cwd must fall
    // back to the default; submitting the vanished cwd reds this case.
    const thirdWs = {
      id: 'ws-3',
      cwd: '/w-third',
      primary: false,
      trusted: true,
    };
    const onCreateGoal = vi.fn().mockResolvedValue(undefined);
    await mount([], {
      workspaces: [primaryWs, secondaryWs, thirdWs],
      defaultWorkspaceCwd: '/w-secondary',
      onCreateGoal,
      listGoalsByWorkspace: {},
    });

    click(findButton('New goal'));
    expect(document.querySelector('select')!.value).toBe('/w-secondary');

    // The refresh removes the selected workspace; two remain, so the view
    // stays multi-workspace and the form keeps its state.
    await act(async () => {
      root!.render(
        <I18nProvider language="en">
          <GoalsDialog
            onCreateGoal={onCreateGoal}
            onOpenSession={vi.fn()}
            onError={vi.fn()}
            workspaces={[primaryWs, thirdWs]}
            defaultWorkspaceCwd="/w-secondary"
          />
        </I18nProvider>,
      );
    });
    await flush();

    const select = document.querySelector('select');
    expect(select!.value).toBe('/w-primary');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual([
      '/w-primary',
      '/w-third',
    ]);

    setTextarea('ship it');
    click(findButton('Set goal'));
    await flush();

    expect(onCreateGoal).toHaveBeenCalledWith('ship it', '/w-primary');
  });

  it('shows no picker or badges for a single workspace', async () => {
    const onOpenSession = vi.fn();
    await mount([baseGoal()], { workspaces: [primaryWs], onOpenSession });

    expect(actions.listGoals).toHaveBeenCalledWith();
    expect(actions.listGoals).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="goal-workspace"]')).toBeNull();

    click(findButton('New goal'));
    expect(document.querySelector('select')).toBeNull();
    click(findButton('Cancel'));

    // Untagged badge, but the sole workspace's context still travels with the
    // session open, matching the scheduled-tasks single-project branch.
    click(findButton('fix-ci'));
    expect(onOpenSession).toHaveBeenCalledWith('sess-1', '/w-primary');
  });

  it('lists only the locked workspace, without picker or badges', async () => {
    const onOpenSession = vi.fn();
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      lockedWorkspace: secondaryWs,
      onOpenSession,
      listGoalsByWorkspace: {
        'ws-2': {
          goals: [
            baseGoal({
              sessionId: 's1',
              condition: 'locked goal',
              displayName: null,
            }),
          ],
          droppedCount: 0,
        },
      },
    });

    expect(actions.listGoals).toHaveBeenCalledWith('ws-2');
    expect(actions.listGoals).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('locked goal');
    expect(document.querySelector('[data-testid="goal-workspace"]')).toBeNull();

    click(findButton('New goal'));
    expect(document.querySelector('select')).toBeNull();
    click(findButton('Cancel'));

    // No badge, but the session still opens in the locked workspace's context.
    click(findButton('s1'));
    expect(onOpenSession).toHaveBeenCalledWith('s1', '/w-secondary');
  });

  it('opens a goal session in its own workspace', async () => {
    const onOpenSession = vi.fn();
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      onOpenSession,
      listGoalsByWorkspace: {
        '': { goals: [], droppedCount: 0 },
        'ws-2': {
          goals: [
            baseGoal({
              sessionId: 's1',
              condition: 'secondary goal',
              displayName: 'sec-session',
            }),
          ],
          droppedCount: 0,
        },
      },
    });

    click(findButton('sec-session'));

    expect(onOpenSession).toHaveBeenCalledWith('s1', '/w-secondary');
  });

  it('shows no workspace picker when editing an existing goal', async () => {
    await mount([], {
      workspaces: [primaryWs, secondaryWs],
      listGoalsByWorkspace: {
        '': { goals: [], droppedCount: 0 },
        'ws-2': {
          goals: [baseGoal({ sessionId: 's1', condition: 'secondary goal' })],
          droppedCount: 0,
        },
      },
    });

    click(document.querySelector('button[aria-label="Edit goal"]'));
    expect(document.querySelector('textarea')).not.toBeNull();
    expect(document.querySelector('select')).toBeNull();
  });
});
