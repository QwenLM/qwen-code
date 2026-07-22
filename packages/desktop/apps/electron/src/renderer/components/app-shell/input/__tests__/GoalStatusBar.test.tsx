import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GoalSnapshotV2 } from '../../../../../shared/types';
import {
  formatGoalElapsed,
  getGoalElapsedMs,
  GoalStatusBar,
  type GoalStatusBarLabels,
} from '../GoalStatusBar';

const labels: GoalStatusBarLabels = {
  status: {
    active: 'Active goal',
    paused: 'Paused',
    blocked: 'Blocked',
    usage_limited: 'Usage limited',
    complete: 'Completed',
  },
  activity: {
    idle: 'Idle',
    running: 'Working',
    verifying: 'Verifying',
  },
  edit: 'Edit goal',
  pause: 'Pause goal',
  resume: 'Resume goal',
  clear: 'Clear goal',
  save: 'Save',
  cancel: 'Cancel',
  objective: 'Goal objective',
  elapsed: 'Active time',
};

function snapshot(
  status: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'complete',
  activity: GoalSnapshotV2['activity'] = 'idle',
): GoalSnapshotV2 {
  return {
    v: 2,
    goal: {
      goalId: 'goal-1',
      revision: 7,
      objective: 'Align every interface',
      status,
      evidenceCursor: { recordId: 'record-7' },
      turnCount: 5,
      activeTimeMs: 65_000,
      createdAt: 1_000,
      updatedAt: 100_000,
    },
    activity,
  };
}

describe('GoalStatusBar', () => {
  it('renders the compact active control strip with accessible actions', () => {
    const html = renderToStaticMarkup(
      <GoalStatusBar
        snapshot={snapshot('active')}
        labels={labels}
        onControl={async () => {}}
      />,
    );

    expect(html).toContain('Active goal');
    expect(html).toContain('Align every interface');
    expect(html).toContain('aria-label="Edit goal"');
    expect(html).toContain('aria-label="Pause goal"');
    expect(html).toContain('aria-label="Clear goal"');
    expect(html).not.toContain('aria-label="Resume goal"');
  });

  it('renders resume instead of pause for a paused Goal', () => {
    const html = renderToStaticMarkup(
      <GoalStatusBar
        snapshot={snapshot('paused')}
        labels={labels}
        onControl={async () => {}}
      />,
    );

    expect(html).toContain('aria-label="Resume goal"');
    expect(html).not.toContain('aria-label="Pause goal"');
  });

  it('renders blocked and usage-limited Goals with resume', () => {
    for (const [status, label] of [
      ['blocked', 'Blocked'],
      ['usage_limited', 'Usage limited'],
    ] as const) {
      const html = renderToStaticMarkup(
        <GoalStatusBar
          snapshot={snapshot(status)}
          labels={labels}
          onControl={async () => {}}
        />,
      );

      expect(html).toContain(label);
      expect(html).toContain('aria-label="Resume goal"');
    }
  });

  it('renders running and verifying activity from the snapshot', () => {
    expect(
      renderToStaticMarkup(
        <GoalStatusBar
          snapshot={snapshot('active', 'running')}
          labels={labels}
          onControl={async () => {}}
        />,
      ),
    ).toContain('Working');
    expect(
      renderToStaticMarkup(
        <GoalStatusBar
          snapshot={snapshot('active', 'verifying')}
          labels={labels}
          onControl={async () => {}}
        />,
      ),
    ).toContain('Verifying');
  });

  it('removes the live strip when the Goal is complete', () => {
    const html = renderToStaticMarkup(
      <GoalStatusBar
        snapshot={snapshot('complete')}
        labels={labels}
        onControl={async () => {}}
      />,
    );

    expect(html).toBe('');

    expect(
      renderToStaticMarkup(
        <GoalStatusBar
          snapshot={{ v: 2, goal: null, activity: 'idle' }}
          labels={labels}
          onControl={async () => {}}
        />,
      ),
    ).toBe('');
  });

  it('ticks only active time and formats it without token or turn budgets', () => {
    expect(getGoalElapsedMs(snapshot('active'), 105_000)).toBe(70_000);
    expect(getGoalElapsedMs(snapshot('paused'), 105_000)).toBe(65_000);
    expect(formatGoalElapsed(70_000)).toBe('1m 10s');
  });
});
