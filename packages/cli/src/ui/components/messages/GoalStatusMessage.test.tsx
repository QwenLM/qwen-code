/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { GoalSnapshotV2 } from '@qwen-code/qwen-code-core';
import { GOAL_STATUS_KINDS, MessageType } from '../../types.js';
import { GoalStatusMessage } from './GoalStatusMessage.js';

function snapshot(
  status: NonNullable<GoalSnapshotV2['goal']>['status'],
  activity: GoalSnapshotV2['activity'] = 'idle',
  lastReason?: string,
  overrides: Partial<NonNullable<GoalSnapshotV2['goal']>> = {},
): GoalSnapshotV2 {
  return {
    v: 2,
    activity,
    goal: {
      goalId: 'goal-1',
      revision: 2,
      objective: 'finish the refactor',
      status,
      evidenceCursor: { recordId: 'record-1' },
      turnCount: 4,
      activeTimeMs: 12_000,
      tokensUsed: 0,
      createdAt: 1_000,
      updatedAt: 13_000,
      ...(lastReason ? { lastReason } : {}),
      ...overrides,
    },
  };
}

describe('<GoalStatusMessage />', () => {
  it('is wrapped in React.memo to avoid unnecessary scrollback rerenders', () => {
    expect(
      (GoalStatusMessage as unknown as { $$typeof?: symbol }).$$typeof,
    ).toBe(Symbol.for('react.memo'));
  });

  it('shows the goal and judge reason on checking cards', () => {
    const { lastFrame } = render(
      <GoalStatusMessage
        kind="checking"
        condition="finish the refactor"
        iterations={2}
        lastReason="tests are still failing"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Goal check');
    expect(output).toContain('turn 2');
    expect(output).toContain('Goal: finish the refactor');
    expect(output).toContain('Judge: tests are still failing');
  });

  it('shows impossible goals as failed terminal cards', () => {
    const { lastFrame } = render(
      <GoalStatusMessage
        kind="failed"
        condition="merge a nonexistent branch"
        iterations={2}
        durationMs={12_000}
        lastReason="the remote branch does not exist"
      />,
    );

    const output = lastFrame();
    expect(output).toContain('✖');
    expect(output).toContain('Goal could not be achieved');
    expect(output).toContain('2 turns');
    expect(output).toContain('Goal: merge a nonexistent branch');
    expect(output).toContain('Last check: the remote branch does not exist');
  });

  it('keeps the legacy GoalStatusKind union closed', () => {
    expect(GOAL_STATUS_KINDS).toEqual([
      'set',
      'achieved',
      'cleared',
      'failed',
      'aborted',
      'paused',
      'checking',
    ]);
    expect(MessageType.GOAL_STATE).toBe('goal_state');
  });

  it('renders legacy pause as a non-terminal paused card', () => {
    const { lastFrame } = render(
      <GoalStatusMessage
        kind="paused"
        condition="finish the refactor"
        iterations={2}
        durationMs={12_000}
      />,
    );

    const output = lastFrame();
    expect(output).toContain('Goal paused');
    expect(output).not.toContain('Goal aborted');
  });

  it.each([
    ['active', snapshot('active', 'running'), '◎', 'Goal running'],
    ['verifying', snapshot('active', 'verifying'), '○', 'Goal checking'],
    [
      'paused',
      snapshot('paused', 'idle', 'paused by the user'),
      '!',
      'Goal paused',
    ],
    [
      'blocked',
      snapshot('blocked', 'idle', 'approval is required'),
      '✖',
      'Goal blocked',
    ],
    [
      'usage limited',
      snapshot('usage_limited', 'idle', 'provider quota reached'),
      '!',
      'Goal usage limited',
    ],
    [
      'complete',
      snapshot('complete', 'idle', 'all acceptance checks passed'),
      '✓',
      'Goal complete',
    ],
  ])('renders v2 %s state as a lifecycle card', (_name, value, icon, title) => {
    const { lastFrame } = render(<GoalStatusMessage snapshot={value} />);

    const output = lastFrame();
    expect(output).toContain(icon);
    expect(output).toContain(title);
    expect(output).toContain('Goal: finish the refactor');
    expect(output).toContain('4 turns');
    expect(output).toContain('12s');
    if (value.goal?.lastReason) {
      expect(output).toContain(`Reason: ${value.goal.lastReason}`);
    }
  });

  it('reports spend against the budget on a lifecycle card', () => {
    const { lastFrame } = render(
      <GoalStatusMessage
        snapshot={snapshot('active', 'running', undefined, {
          tokensUsed: 1_234,
          tokenBudget: 30_000_000,
        })}
      />,
    );

    expect(lastFrame()).toContain('4 turns · 12s · 1.2k/30.0m tokens');
  });

  it('reports spend alone when the Goal has no budget', () => {
    const { lastFrame } = render(
      <GoalStatusMessage
        snapshot={snapshot('paused', 'idle', undefined, {
          tokensUsed: 1_234,
        })}
      />,
    );

    expect(lastFrame()).toContain('1.2k tokens');
    expect(lastFrame()).not.toContain('1.2k/');
  });

  it('says nothing about spend before a turn has billed', () => {
    const { lastFrame } = render(
      <GoalStatusMessage
        snapshot={snapshot('active', 'running', undefined, {
          tokenBudget: 30_000_000,
        })}
      />,
    );

    expect(lastFrame()).toContain('4 turns · 12s');
    expect(lastFrame()).not.toContain('tokens');
  });

  it('leaves the legacy card without spend it cannot know', () => {
    // The legacy props carry an iteration count and nothing else; there is no
    // record behind them to read a spend off.
    const { lastFrame } = render(
      <GoalStatusMessage kind="set" condition="finish the refactor" />,
    );

    expect(lastFrame()).not.toContain('tokens');
  });
});
