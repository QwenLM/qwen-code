/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { GoalStatusMessage } from './GoalStatusMessage.js';

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
});
