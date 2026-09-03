/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  hasBlockingBackgroundWork,
  resetBackgroundStateForSessionSwitch,
  describeBlockingBackgroundWork,
  buildBackgroundWorkBlockedMessage,
} from './backgroundWorkUtils.js';

function createMockConfig(overrides?: {
  hasRunningTasks?: boolean;
  runningMonitors?: unknown[];
  hasRunningEntries?: boolean;
  hasRunningWorkflows?: boolean;
}): Config {
  return {
    getBackgroundTaskRegistry: () => ({
      hasRunningTasks: () => overrides?.hasRunningTasks ?? false,
      reset: vi.fn(),
    }),
    getMonitorRegistry: () => ({
      getRunning: () => overrides?.runningMonitors ?? [],
      reset: vi.fn(),
    }),
    getBackgroundShellRegistry: () => ({
      hasRunningEntries: () => overrides?.hasRunningEntries ?? false,
      reset: vi.fn(),
    }),
    getWorkflowRunRegistry: () => ({
      hasRunningEntries: () => overrides?.hasRunningWorkflows ?? false,
      reset: vi.fn(),
    }),
  } as unknown as Config;
}

describe('hasBlockingBackgroundWork', () => {
  it('returns false when nothing is running', () => {
    expect(hasBlockingBackgroundWork(createMockConfig())).toBe(false);
  });

  // #5949: the gate keys off hasRunningTasks(), NOT hasUnfinalizedTasks()
  // — a cancelled task whose finalize callback hasn't fired yet must not
  // block /clear or session resume (both abort-and-reset right after the
  // gate, suppressing the pending notification anyway).
  it('returns true when background tasks are still running', () => {
    expect(
      hasBlockingBackgroundWork(createMockConfig({ hasRunningTasks: true })),
    ).toBe(true);
  });

  it('returns true when monitors are running', () => {
    expect(
      hasBlockingBackgroundWork(
        createMockConfig({ runningMonitors: [{ id: 'm1' }] }),
      ),
    ).toBe(true);
  });

  it('returns true when shell entries are running', () => {
    expect(
      hasBlockingBackgroundWork(createMockConfig({ hasRunningEntries: true })),
    ).toBe(true);
  });

  // R7 (wenshao): workflow registry is the 4th sibling. Without
  // including it in the OR chain, /clear and session-resume happily
  // ran while a workflow was mid-run, orphaning the dispatch loop.
  it('returns true when a workflow is still running', () => {
    expect(
      hasBlockingBackgroundWork(
        createMockConfig({ hasRunningWorkflows: true }),
      ),
    ).toBe(true);
  });

  it('short-circuits: does not check monitors or shells when tasks are running', () => {
    const config = {
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: () => true,
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => {
        throw new Error('should not be called');
      },
      getBackgroundShellRegistry: () => {
        throw new Error('should not be called');
      },
    } as unknown as Config;

    expect(hasBlockingBackgroundWork(config)).toBe(true);
  });

  it('short-circuits: does not check shells when monitors are running', () => {
    const config = {
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: () => false,
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: () => [{ id: 'm1' }],
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => {
        throw new Error('should not be called');
      },
    } as unknown as Config;

    expect(hasBlockingBackgroundWork(config)).toBe(true);
  });
});

describe('resetBackgroundStateForSessionSwitch', () => {
  it('calls reset on all four registries', () => {
    const resetTasks = vi.fn();
    const resetMonitors = vi.fn();
    const resetShells = vi.fn();
    const resetWorkflows = vi.fn();
    const abortWorkflows = vi.fn();

    const config = {
      getBackgroundTaskRegistry: () => ({ reset: resetTasks }),
      getMonitorRegistry: () => ({ reset: resetMonitors }),
      getBackgroundShellRegistry: () => ({ reset: resetShells }),
      getWorkflowRunRegistry: () => ({
        reset: resetWorkflows,
        abortAll: abortWorkflows,
      }),
    } as unknown as Config;

    resetBackgroundStateForSessionSwitch(config);

    expect(resetTasks).toHaveBeenCalledOnce();
    expect(resetMonitors).toHaveBeenCalledOnce();
    expect(resetShells).toHaveBeenCalledOnce();
    expect(resetWorkflows).toHaveBeenCalledOnce();
    // R12 (doudouOUC): paused runs no longer block the switch, so they
    // must be cancelled before reset() drops their entries — aborting
    // after reset would find nothing and leak the gated script.
    expect(abortWorkflows).toHaveBeenCalledOnce();
    expect(abortWorkflows).toHaveBeenCalledBefore(resetWorkflows);
  });
});

function createEnumeratingMockConfig(overrides?: {
  agents?: unknown[];
  monitors?: unknown[];
  shells?: unknown[];
  workflows?: unknown[];
  startingWorkflows?: string[];
}): Config {
  return {
    getBackgroundTaskRegistry: () => ({
      getAll: () => overrides?.agents ?? [],
    }),
    getMonitorRegistry: () => ({
      getRunning: () => overrides?.monitors ?? [],
    }),
    getBackgroundShellRegistry: () => ({
      getAll: () => overrides?.shells ?? [],
    }),
    getWorkflowRunRegistry: () => ({
      list: () => overrides?.workflows ?? [],
      listStartingRunIds: () => overrides?.startingWorkflows ?? [],
    }),
  } as unknown as Config;
}

describe('describeBlockingBackgroundWork (#8741)', () => {
  const now = Date.now();

  it('returns undefined when no entry is running', () => {
    const config = createEnumeratingMockConfig({
      agents: [
        {
          agentId: 'bg_done',
          isBackgrounded: true,
          status: 'completed',
          description: 'done',
          startTime: now,
        },
      ],
      shells: [
        {
          shellId: 'shell_done',
          status: 'completed',
          command: 'echo hi',
          startTime: now,
        },
      ],
      workflows: [
        { runId: 'wf_done', status: 'completed', meta: null, startTime: now },
      ],
    });
    expect(describeBlockingBackgroundWork(config)).toBeUndefined();
  });

  it('lists running backgrounded agents, skipping foreground and paused ones', () => {
    const config = createEnumeratingMockConfig({
      agents: [
        {
          agentId: 'bg_run',
          isBackgrounded: true,
          status: 'running',
          description: 'research the codebase',
          subagentType: 'Explore',
          startTime: now - 75_600_000,
        },
        {
          agentId: 'fg_run',
          isBackgrounded: false,
          status: 'running',
          description: 'foreground work',
          startTime: now,
        },
        {
          agentId: 'bg_paused',
          isBackgrounded: true,
          status: 'paused',
          description: 'paused work',
          startTime: now,
        },
      ],
    });
    const summary = describeBlockingBackgroundWork(config);
    expect(summary?.lines).toHaveLength(1);
    expect(summary?.lines[0]).toContain('[bg_run]');
    expect(summary?.lines[0]).toContain('Explore: research the codebase');
    expect(summary?.lines[0]).toContain('(running 21h)');
    expect(summary?.hasTaskEntries).toBe(true);
    expect(summary?.hasStartingWorkflowRuns).toBe(false);
  });

  it('lists monitors, running shells, and running/pausing workflow runs', () => {
    const config = createEnumeratingMockConfig({
      monitors: [
        {
          monitorId: 'mon_1',
          status: 'running',
          description: 'tail -f app.log',
          startTime: now,
        },
      ],
      shells: [
        {
          shellId: 'shell_1',
          status: 'running',
          command: 'npm run dev',
          startTime: now,
        },
        {
          shellId: 'shell_2',
          status: 'cancelled',
          command: 'echo gone',
          startTime: now,
        },
      ],
      workflows: [
        {
          runId: 'wf_1',
          status: 'running',
          meta: { name: 'nightly' },
          startTime: now,
        },
        { runId: 'wf_2', status: 'pausing', meta: null, startTime: now },
        { runId: 'wf_3', status: 'paused', meta: null, startTime: now },
      ],
    });
    const summary = describeBlockingBackgroundWork(config);
    expect(summary?.lines).toHaveLength(4);
    const joined = summary?.lines.join('\n');
    expect(joined).toContain('[mon_1]');
    expect(joined).toContain('[shell_1]');
    expect(joined).toContain('npm run dev');
    expect(joined).toContain('[wf_1]');
    expect(joined).toContain('nightly');
    // meta-less runs fall back to the runId as their label
    expect(joined).toContain('[wf_2]');
    expect(joined).not.toContain('shell_2');
    expect(joined).not.toContain('wf_3');
    expect(summary?.hasTaskEntries).toBe(true);
    expect(summary?.hasInspectableWorkflowRuns).toBe(true);
    expect(summary?.hasStartingWorkflowRuns).toBe(false);
  });

  it('lists workflow runs that are still starting', () => {
    const summary = describeBlockingBackgroundWork(
      createEnumeratingMockConfig({ startingWorkflows: ['wf_starting'] }),
    );

    expect(summary?.lines).toEqual(['  [wf_starting] (starting)']);
    expect(summary?.hasTaskEntries).toBe(false);
    expect(summary?.hasStartingWorkflowRuns).toBe(true);
  });

  it('renders a starting run without a fabricated duration', () => {
    const summary = describeBlockingBackgroundWork(
      createEnumeratingMockConfig({ startingWorkflows: ['wf_a', 'wf_b'] }),
    );
    expect(summary?.lines).toHaveLength(2);
    for (const line of summary!.lines) {
      // A reservation has no registered startTime; printing one would
      // report a duration the run has not run for.
      expect(line).not.toMatch(/\d+s\)/);
      expect(line).toMatch(/\(starting\)$/);
    }
  });

  it('lists a starting run alongside a registered one, newest last', () => {
    const summary = describeBlockingBackgroundWork(
      createEnumeratingMockConfig({
        workflows: [
          {
            runId: 'wf_running',
            status: 'running',
            meta: { name: 'build' },
            startTime: 1_000,
          },
        ],
        startingWorkflows: ['wf_starting'],
      }),
    );
    expect(summary?.lines).toHaveLength(2);
    expect(summary!.lines[0]).toContain('[wf_running]');
    expect(summary!.lines[1]).toBe('  [wf_starting] (starting)');
  });

  it('does not send /clear to /workflows for a run it cannot show', () => {
    const message = buildBackgroundWorkBlockedMessage(
      createEnumeratingMockConfig({ startingWorkflows: ['wf_starting'] }),
      'Cannot clear.',
    );
    expect(message).toContain('Cannot clear.');
    expect(message).toContain('  [wf_starting] (starting)');
    // `/workflows` reads registry.list(), which a reservation has not
    // entered — pointing there would name a list that cannot show it.
    expect(message).not.toContain('Use ');
    expect(message).toContain('Retry once the run has finished starting.');
  });

  it('still points at /workflows when a registered run also blocks', () => {
    const message = buildBackgroundWorkBlockedMessage(
      createEnumeratingMockConfig({
        workflows: [
          {
            runId: 'wf_running',
            status: 'running',
            meta: { name: 'build' },
            startTime: 1_000,
          },
        ],
        startingWorkflows: ['wf_starting'],
      }),
      'Cannot clear.',
    );
    expect(message).toContain('Use /workflows to inspect them, then retry.');
    expect(message).toContain('Retry once the run has finished starting.');
  });

  it('keeps the starting-run hint when the starting row overflows', () => {
    const shells = Array.from({ length: 10 }, (_, i) => ({
      shellId: `shell_${i}`,
      status: 'running',
      command: `cmd ${i}`,
      startTime: now - (10 - i) * 1_000,
    }));
    const message = buildBackgroundWorkBlockedMessage(
      createEnumeratingMockConfig({
        shells,
        startingWorkflows: ['wf_starting'],
      }),
      'Cannot clear.',
    );

    expect(message).not.toContain('[wf_starting]');
    expect(message).toContain('  …and 1 more');
    expect(message).toContain('Retry once the run has finished starting.');
  });

  it('sorts lines by start time', () => {
    const config = createEnumeratingMockConfig({
      shells: [
        {
          shellId: 'shell_new',
          status: 'running',
          command: 'new',
          startTime: now - 1_000,
        },
        {
          shellId: 'shell_old',
          status: 'running',
          command: 'old',
          startTime: now - 60_000,
        },
      ],
    });
    const summary = describeBlockingBackgroundWork(config);
    expect(summary?.lines[0]).toContain('[shell_old]');
    expect(summary?.lines[1]).toContain('[shell_new]');
  });

  it('sanitizes user-supplied labels', () => {
    const config = createEnumeratingMockConfig({
      shells: [
        {
          shellId: 'shell_evil',
          status: 'running',
          command: 'npm run dev\u001b[31m\u0007',
          startTime: now,
        },
      ],
    });
    const summary = describeBlockingBackgroundWork(config);
    expect(summary?.lines[0]).toContain('npm run dev');
    expect(summary?.lines[0]).not.toContain('\u001b');
    expect(summary?.lines[0]).not.toContain('\u0007');
  });

  it('flattens newlines in labels so one entry stays one line', () => {
    const config = createEnumeratingMockConfig({
      shells: [
        {
          shellId: 'shell_multi',
          status: 'running',
          command: 'npm run dev\necho forged line',
          startTime: now,
        },
      ],
    });
    const summary = describeBlockingBackgroundWork(config);
    expect(summary?.lines).toHaveLength(1);
    expect(summary?.lines[0]).toContain('npm run dev echo forged line');
    expect(summary?.lines[0]).not.toContain('\n');
  });

  it('caps label width', () => {
    const config = createEnumeratingMockConfig({
      shells: [
        {
          shellId: 'shell_long',
          status: 'running',
          command: 'x'.repeat(100),
          startTime: now,
        },
      ],
    });
    expect(describeBlockingBackgroundWork(config)?.lines[0]).toContain(
      `${'x'.repeat(79)}…`,
    );
  });

  it('caps enumeration at 10 lines plus an overflow tail', () => {
    const shells = Array.from({ length: 12 }, (_, i) => ({
      shellId: `shell_${i}`,
      status: 'running',
      command: `cmd ${i}`,
      startTime: now - (12 - i) * 1_000,
    }));
    const summary = describeBlockingBackgroundWork(
      createEnumeratingMockConfig({ shells }),
    );
    expect(summary?.lines).toHaveLength(11);
    expect(summary?.lines[10]).toBe('  …and 2 more');
    expect(summary?.lines.join('\n')).toContain('[shell_0]');
  });
});

describe('buildBackgroundWorkBlockedMessage (#8741)', () => {
  const base = 'base blocked message';
  const now = Date.now();

  it('returns the bare base message when nothing is enumerated', () => {
    expect(
      buildBackgroundWorkBlockedMessage(createEnumeratingMockConfig(), base),
    ).toBe(base);
  });

  it('appends the entries and a /tasks hint for task-kind blockers', () => {
    const config = createEnumeratingMockConfig({
      shells: [
        {
          shellId: 'shell_1',
          status: 'running',
          command: 'npm run dev',
          startTime: now,
        },
      ],
    });
    const message = buildBackgroundWorkBlockedMessage(config, base);
    expect(message.startsWith(base)).toBe(true);
    expect(message).toContain('[shell_1]');
    expect(message).toContain('Use /tasks to inspect them, then retry.');
    expect(message).not.toContain('Retry once the run has finished starting.');
  });

  it('points at /workflows when only workflow runs block', () => {
    const config = createEnumeratingMockConfig({
      workflows: [
        { runId: 'wf_1', status: 'running', meta: null, startTime: now },
      ],
    });
    const message = buildBackgroundWorkBlockedMessage(config, base);
    expect(message).toContain('Use /workflows to inspect them, then retry.');
    expect(message).not.toContain('/tasks');
  });

  it('points at both surfaces when both kinds block', () => {
    const config = createEnumeratingMockConfig({
      monitors: [
        {
          monitorId: 'mon_1',
          status: 'running',
          description: 'watch',
          startTime: now,
        },
      ],
      workflows: [
        { runId: 'wf_1', status: 'running', meta: null, startTime: now },
      ],
    });
    const message = buildBackgroundWorkBlockedMessage(config, base);
    expect(message).toContain(
      'Use /tasks and /workflows to inspect them, then retry.',
    );
  });
});
