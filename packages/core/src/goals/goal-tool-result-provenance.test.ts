/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
  ambientGoalToolResultProvenance,
  goalToolResultProvenance,
} from './goal-tool-result-provenance.js';

const permit = { goalId: 'g-1', revision: 2, turnId: 't-1' };

describe('goalToolResultProvenance', () => {
  it('stamps an ordinary tool result with the permit that asked for it', () => {
    // Without the stamp the catalog derives no provenance at all, so the
    // result cannot become the `external_fact` a completion is proved with.
    expect(
      goalToolResultProvenance({
        name: 'run_shell_command',
        goalContext: permit,
      }),
    ).toEqual({ goalContext: permit });
  });

  it('copies the permit rather than aliasing the request', () => {
    const request = { name: 'read_file', goalContext: { ...permit } };
    const options = goalToolResultProvenance(request);
    expect(options?.goalContext).not.toBe(request.goalContext);
    expect(options?.goalContext).toEqual(permit);
  });

  it.each([ToolNames.GET_GOAL, ToolNames.UPDATE_GOAL])(
    'marks %s as the Goal’s own bookkeeping',
    (name) => {
      // Excluded from the catalog on purpose: a Goal that cited its own reads
      // as proof would be arguing in a circle.
      expect(goalToolResultProvenance({ name, goalContext: permit })).toEqual({
        goalContext: permit,
        provenance: 'goal_runtime',
      });
    },
  );

  it('leaves a tool call made outside a Goal turn unstamped', () => {
    expect(goalToolResultProvenance({ name: 'read_file' })).toBeUndefined();
  });
});

describe('ambientGoalToolResultProvenance', () => {
  it('reads the permit from the surrounding Goal turn', () => {
    const options = goalTurnContext.run(permit, () =>
      ambientGoalToolResultProvenance('run_shell_command'),
    );
    expect(options).toEqual({ goalContext: permit });
  });

  it('applies the same bookkeeping rule inside a turn', () => {
    const options = goalTurnContext.run(permit, () =>
      ambientGoalToolResultProvenance(ToolNames.GET_GOAL),
    );
    expect(options).toEqual({
      goalContext: permit,
      provenance: 'goal_runtime',
    });
  });

  it('stamps nothing outside a Goal turn', () => {
    expect(ambientGoalToolResultProvenance('read_file')).toBeUndefined();
  });
});
