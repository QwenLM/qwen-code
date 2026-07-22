/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as goals from './index.js';

const legacyRuntimeModules = [
  './activeGoalStore.ts',
  './goalHook.ts',
  './goalJudge.ts',
];

const legacyRuntimeExports = [
  'getActiveGoal',
  'setActiveGoal',
  'clearActiveGoal',
  'recordGoalIteration',
  'setGoalTerminalObserver',
  'MAX_GOAL_ITERATIONS',
  'createGoalStopHookCallback',
  'registerGoalHook',
  'unregisterGoalHook',
  'judgeGoal',
];

describe('Goal runtime cutover', () => {
  it('does not expose the legacy Goal writer or Stop-hook runtime', () => {
    for (const name of legacyRuntimeExports) {
      expect(goals).not.toHaveProperty(name);
    }
  });

  it('removes the legacy Goal runtime modules', () => {
    for (const modulePath of legacyRuntimeModules) {
      expect(
        existsSync(fileURLToPath(new URL(modulePath, import.meta.url))),
      ).toBe(false);
    }
  });

  it('does not retain Goal-specific handling in generic Stop hooks', () => {
    const configPath = fileURLToPath(
      new URL('../config/config.ts', import.meta.url),
    );
    const source = readFileSync(configPath, 'utf8');

    expect(source).not.toContain('GOAL_HOOK_ID_OUTPUT_KEY');
    expect(source).not.toContain('hasNonGoalBlockingStopHook');
  });
});
