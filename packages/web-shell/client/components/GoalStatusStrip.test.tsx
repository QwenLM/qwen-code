// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { GoalStatusStrip, getGoalActiveTimeMs } from './GoalStatusStrip';

function snapshot(
  status: NonNullable<GoalSnapshotV2['goal']>['status'],
): GoalSnapshotV2 {
  return {
    v: 2,
    activity: status === 'active' ? 'running' : 'idle',
    goal: {
      goalId: 'goal-1',
      revision: 2,
      objective: 'ship every surface',
      status,
      evidenceCursor: { recordId: null },
      turnCount: 3,
      activeTimeMs: 4000,
      createdAt: 1000,
      updatedAt: 5000,
    },
  };
}

describe('GoalStatusStrip', () => {
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

  function render(status: NonNullable<GoalSnapshotV2['goal']>['status']) {
    const handlers = {
      onEdit: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onClear: vi.fn(),
    };
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GoalStatusStrip snapshot={snapshot(status)} {...handlers} />
        </I18nProvider>,
      );
    });
    return handlers;
  }

  it('shows pause for an active Goal and wires actions', () => {
    const handlers = render('active');
    expect(container.textContent).toContain('In progress');
    expect(container.textContent).toContain('ship every surface');

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Edit goal"]')!
        .click();
      container
        .querySelector<HTMLButtonElement>('[aria-label="Pause goal"]')!
        .click();
      container
        .querySelector<HTMLButtonElement>('[aria-label="Clear goal"]')!
        .click();
    });

    expect(handlers.onEdit).toHaveBeenCalledOnce();
    expect(handlers.onPause).toHaveBeenCalledOnce();
    expect(handlers.onClear).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Resume goal"]')).toBeNull();
  });

  it('shows resume for recoverable stopped states and hides completed Goals', () => {
    render('blocked');
    expect(
      container.querySelector('[aria-label="Resume goal"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Pause goal"]')).toBeNull();

    act(() => {
      root.render(
        <I18nProvider language="en">
          <GoalStatusStrip
            snapshot={snapshot('complete')}
            onEdit={vi.fn()}
            onPause={vi.fn()}
            onResume={vi.fn()}
            onClear={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(
      container.querySelector('[data-testid="goal-status-strip"]'),
    ).toBeNull();
  });

  it('offers resume for an evidence-limited Goal', () => {
    const limited = snapshot('usage_limited');
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GoalStatusStrip
            snapshot={{
              ...limited,
              goal: { ...limited.goal!, limitKind: 'evidence_catalog' },
            }}
            onEdit={vi.fn()}
            onPause={vi.fn()}
            onResume={vi.fn()}
            onClear={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('[aria-label="Resume goal"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="goal-status-strip"]'),
    ).not.toBeNull();
  });

  it('offers resume for a Goal evidence-limited before `limitKind` existed', () => {
    // The sentinel prose shipped before the `limitKind` field did, so a Goal
    // persisted in that window restores as `usage_limited` with no `limitKind`
    // at all. The strip does not parse the prose -- resumability is decided by
    // status alone -- so one representative sentinel is enough here.
    const limited = snapshot('usage_limited');
    const lastReason =
      'The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.';
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GoalStatusStrip
            snapshot={{ ...limited, goal: { ...limited.goal!, lastReason } }}
            onEdit={vi.fn()}
            onPause={vi.fn()}
            onResume={vi.fn()}
            onClear={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(
      container.querySelector('[aria-label="Resume goal"]'),
    ).not.toBeNull();
  });

  it('still offers resume for an ordinary usage-limited stop', () => {
    // Reverse control for the test above: operational stops carry prose in
    // `lastReason` too and the reducer resumes them, so the fallback must not
    // widen into "any usage_limited Goal with a reason".
    const limited = snapshot('usage_limited');
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GoalStatusStrip
            snapshot={{
              ...limited,
              goal: {
                ...limited.goal!,
                lastReason: 'The provider rate-limited this account.',
              },
            }}
            onEdit={vi.fn()}
            onPause={vi.fn()}
            onResume={vi.fn()}
            onClear={vi.fn()}
          />
        </I18nProvider>,
      );
    });
    expect(
      container.querySelector('[aria-label="Resume goal"]'),
    ).not.toBeNull();
  });

  it('adds current active time only while active', () => {
    expect(getGoalActiveTimeMs(snapshot('active'), 8000)).toBe(7000);
    expect(getGoalActiveTimeMs(snapshot('paused'), 8000)).toBe(4000);
  });
});
