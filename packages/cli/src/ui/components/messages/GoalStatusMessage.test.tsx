/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { GoalStatusMessage } from './GoalStatusMessage.js';

describe('<GoalStatusMessage />', () => {
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
});
