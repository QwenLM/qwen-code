// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalSnapshotV2 } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { GoalStatusStrip, getGoalActiveTimeMs } from './GoalStatusStrip';

const snapshot = (
  over: Partial<NonNullable<GoalSnapshotV2['goal']>> = {},
  activity: GoalSnapshotV2['activity'] = 'idle',
): GoalSnapshotV2 => ({
  v: 2,
  activity,
  goal: {
    goalId: 'goal-1',
    revision: 3,
    objective: 'ship all surfaces',
    status: 'active',
    evidenceCursor: { recordId: null },
    turnCount: 4,
    activeTimeMs: 2_000,
    createdAt: 1_000,
    updatedAt: 8_000,
    ...over,
  },
});

describe('GoalStatusStrip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(value: GoalSnapshotV2, handlers = {}) {
    const props = {
      onEdit: vi.fn(),
      onPause: vi.fn(),
      onResume: vi.fn(),
      onClear: vi.fn(),
      ...handlers,
    };
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GoalStatusStrip snapshot={value} {...props} />
        </I18nProvider>,
      );
    });
    return props;
  }

  it('shows authoritative objective, lifecycle status and active elapsed time', () => {
    render(snapshot());
    expect(container.textContent).toContain('In progress');
    expect(container.textContent).toContain('ship all surfaces');
    expect(
      container.querySelector('[data-testid="goal-active-elapsed"]')
        ?.textContent,
    ).toBe('4s');
    expect(container.querySelector('[aria-label="Pause goal"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Resume goal"]')).toBeNull();
  });

  it('freezes elapsed time while paused and offers resume', () => {
    render(
      snapshot({ status: 'paused', activeTimeMs: 61_000, updatedAt: 4_000 }),
    );
    expect(container.textContent).toContain('Paused');
    expect(
      container.querySelector('[data-testid="goal-active-elapsed"]')
        ?.textContent,
    ).toBe('1m 1s');
    expect(container.querySelector('[aria-label="Pause goal"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Resume goal"]'),
    ).not.toBeNull();
  });

  it('shows blocked and usage-limited lifecycle states with resume', () => {
    for (const [status, label] of [
      ['blocked', 'Blocked'],
      ['usage_limited', 'Usage limited'],
    ] as const) {
      render(snapshot({ status }));
      expect(container.textContent).toContain(label);
      expect(
        container.querySelector('[aria-label="Resume goal"]'),
      ).not.toBeNull();
    }
  });

  it('shows running and verifying activity from the authoritative snapshot', () => {
    render(snapshot({}, 'running'));
    expect(container.textContent).toContain('Working');

    render(snapshot({}, 'verifying'));
    expect(container.textContent).toContain('Verifying');
  });

  it('hides complete and null snapshots', () => {
    render(snapshot({ status: 'complete' }));
    expect(container.querySelector('[data-testid="goal-status-strip"]')).toBe(
      null,
    );

    render({ v: 2, goal: null, activity: 'idle' });
    expect(container.querySelector('[data-testid="goal-status-strip"]')).toBe(
      null,
    );
  });

  it('wires control actions without exposing budgets or turn caps', () => {
    const handlers = render(snapshot());
    act(() => {
      (
        container.querySelector('[aria-label="Edit goal"]') as HTMLElement
      ).click();
      (
        container.querySelector('[aria-label="Pause goal"]') as HTMLElement
      ).click();
      (
        container.querySelector('[aria-label="Clear goal"]') as HTMLElement
      ).click();
    });
    expect(handlers.onEdit).toHaveBeenCalledOnce();
    expect(handlers.onPause).toHaveBeenCalledOnce();
    expect(handlers.onClear).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('turn');
    expect(container.textContent).not.toContain('token');
  });
});

describe('getGoalActiveTimeMs', () => {
  it('adds only the current active interval', () => {
    expect(getGoalActiveTimeMs(snapshot(), 10_000)).toBe(4_000);
    expect(getGoalActiveTimeMs(snapshot({ status: 'blocked' }), 10_000)).toBe(
      2_000,
    );
  });
});
