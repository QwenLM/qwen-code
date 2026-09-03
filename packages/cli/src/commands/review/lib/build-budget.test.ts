/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BUILD_TEST_BUDGET_HEADROOM_S,
  SHELL_TOOL_MAX_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_S,
  DEFAULT_WHOLE_CALL_BUDGET_S,
  MAX_RESUME_CALLS,
} from './build-budget.js';

describe('build-test budget constants', () => {
  it('keeps the whole-call budget inside the shell tool the brief welds on', () => {
    // The ceiling is not a policy choice: `run_shell_command` refuses
    // `timeout > 600000`. A budget above it produces a call the outer kill is
    // guaranteed to discard — the "71 timeouts, nothing verified" failure
    // build-test exists to end, reproduced from the other side.
    expect(DEFAULT_WHOLE_CALL_BUDGET_S + BUILD_TEST_BUDGET_HEADROOM_S).toBe(
      SHELL_TOOL_MAX_TIMEOUT_MS / 1000,
    );
  });

  it('lets one command use the budget without exceeding it', () => {
    // The per-command deadline is sized to the slowest measured suite (401s on
    // this repo), which only works if a single command may still spend most of
    // a call. It must never exceed the call, or the budget's own floor would
    // be the only thing stopping a command the call cannot hold.
    expect(DEFAULT_COMMAND_TIMEOUT_S).toBeGreaterThan(401);
    expect(DEFAULT_COMMAND_TIMEOUT_S).toBeLessThan(DEFAULT_WHOLE_CALL_BUDGET_S);
  });

  it('bounds how long a review may keep continuing', () => {
    // Four calls of ten minutes is where the dimension stops being cheaper
    // than the reviewer's attention; past it the honest answer is `notRun`.
    expect(MAX_RESUME_CALLS).toBeGreaterThanOrEqual(1);
    expect(MAX_RESUME_CALLS).toBeLessThanOrEqual(5);
  });

  it('is the ONE copy of the ceiling — the brief quotes it, never a literal', () => {
    // The budget comment and the brief used to carry separately-maintained
    // copies of "600 seconds", tied together by nothing but prose.
    const here = dirname(fileURLToPath(import.meta.url));
    const brief = readFileSync(join(here, '..', 'agent-prompt.ts'), 'utf8');
    expect(brief).toContain('SHELL_TOOL_MAX_TIMEOUT_MS');
    expect(brief).not.toContain('`timeout: 600000`');
  });
});
