/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { tasksCommand } from './tasksCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type {
  BackgroundShellEntry,
  BackgroundTaskEntry,
  MonitorEntry,
} from '@qwen-code/qwen-code-core';

type AgentTaskTestEntry = BackgroundTaskEntry & {
  resumeBlockedReason?: string;
};

function entry(
  overrides: Partial<BackgroundShellEntry> = {},
): BackgroundShellEntry {
  return {
    shellId: 'bg_aaaaaaaa',
    command: 'sleep 60',
    cwd: '/tmp',
    status: 'running',
    startTime: Date.now() - 5_000,
    outputPath: '/tmp/tasks/sess/shell-bg_aaaaaaaa.output',
    abortController: new AbortController(),
    ...overrides,
  };
}

function agentEntry(
  overrides: Partial<AgentTaskTestEntry> = {},
): AgentTaskTestEntry {
  return {
    agentId: 'agent_aaaaaaaa',
    description: 'Investigate flaky test failure',
    subagentType: 'researcher',
    status: 'running',
    startTime: Date.now() - 7_000,
    abortController: new AbortController(),
    ...overrides,
  };
}

function monitorEntry(overrides: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    monitorId: 'mon-aaaaaaaa',
    command: 'tail -f app.log',
    description: 'watch app logs',
    status: 'running',
    startTime: Date.now() - 4_000,
    abortController: new AbortController(),
    eventCount: 0,
    lastEventTime: 0,
    maxEvents: 1000,
    idleTimeoutMs: 300_000,
    droppedLines: 0,
    ...overrides,
  };
}

describe('tasksCommand', () => {
  let context: CommandContext;
  let getShells: ReturnType<typeof vi.fn>;
  let getAgents: ReturnType<typeof vi.fn>;
  let getMonitors: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getShells = vi.fn().mockReturnValue([]);
    getAgents = vi.fn().mockReturnValue([]);
    getMonitors = vi.fn().mockReturnValue([]);
    context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {
          getBackgroundShellRegistry: () => ({ getAll: getShells }),
          getBackgroundTaskRegistry: () => ({ getAll: getAgents }),
          getMonitorRegistry: () => ({ getAll: getMonitors }),
        },
      },
    } as unknown as Parameters<typeof createMockCommandContext>[0]);
  });

  it('reports an empty registry', async () => {
    const result = await tasksCommand.action!(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No background tasks.',
    });
  });

  it('lists running and terminal shell entries with status / runtime / output path', async () => {
    getShells.mockReturnValue([
      entry({
        shellId: 'bg_run',
        command: 'npm run dev',
        status: 'running',
        startTime: Date.now() - 12_000,
        pid: 1111,
      }),
      entry({
        shellId: 'bg_done',
        command: 'npm test',
        status: 'completed',
        exitCode: 0,
        startTime: Date.now() - 70_000,
        endTime: Date.now() - 5_000,
        outputPath: '/tmp/tasks/sess/shell-bg_done.output',
      }),
      entry({
        shellId: 'bg_fail',
        command: 'flaky.sh',
        status: 'failed',
        error: 'spawn ENOENT',
        startTime: Date.now() - 3_000,
        endTime: Date.now() - 2_000,
      }),
    ]);

    const result = await tasksCommand.action!(context, '');
    if (!result || result.type !== 'message') {
      throw new Error('expected message result');
    }
    expect(result.content).toContain('Background tasks (3 total)');
    expect(result.content).toContain('[bg_run] running');
    expect(result.content).toContain('pid=1111');
    expect(result.content).toContain('npm run dev');
    expect(result.content).toContain('[bg_done] completed (exit 0)');
    expect(result.content).toContain('[bg_fail] failed: spawn ENOENT');
    expect(result.content).toContain(
      'output: /tmp/tasks/sess/shell-bg_done.output',
    );
  });

  it('includes background agent entries alongside shells', async () => {
    getAgents.mockReturnValue([
      agentEntry({
        agentId: 'agent_run',
        description: 'Fix flaky test and send patch',
        subagentType: 'researcher',
        status: 'running',
        outputFile: '/tmp/tasks/sess/agent_run.jsonl',
      }),
      agentEntry({
        agentId: 'agent_pause',
        description: 'Resume-safe task',
        subagentType: 'researcher',
        status: 'paused',
        resumeBlockedReason: 'Subagent "researcher" is no longer available.',
      }),
    ]);
    getShells.mockReturnValue([
      entry({
        shellId: 'bg_shell',
        command: 'npm run dev',
        status: 'running',
      }),
    ]);

    const result = await tasksCommand.action!(context, '');
    if (!result || result.type !== 'message') {
      throw new Error('expected message result');
    }

    expect(result.content).toContain('Background tasks (3 total)');
    expect(result.content).toContain('[agent_run] running');
    expect(result.content).toContain(
      'researcher: Fix flaky test and send patch',
    );
    expect(result.content).toContain('output: /tmp/tasks/sess/agent_run.jsonl');
    expect(result.content).toContain(
      '[agent_pause] paused (resume blocked): Subagent "researcher" is no longer available.',
    );
    expect(result.content).toContain('[bg_shell] running');
  });

  it('lists monitor entries with eventCount and exit / error suffixes', async () => {
    getMonitors.mockReturnValue([
      monitorEntry({
        monitorId: 'mon_run',
        description: 'tail dev server log',
        status: 'running',
        eventCount: 12,
        pid: 9999,
      }),
      monitorEntry({
        monitorId: 'mon_done',
        description: 'tail short script',
        status: 'completed',
        exitCode: 0,
        eventCount: 7,
        endTime: Date.now() - 1_000,
      }),
      monitorEntry({
        monitorId: 'mon_auto',
        description: 'tail noisy log',
        status: 'completed',
        error: 'Max events reached',
        eventCount: 1000,
        endTime: Date.now() - 500,
      }),
      monitorEntry({
        monitorId: 'mon_fail',
        description: 'tail bad path',
        status: 'failed',
        error: 'spawn ENOENT',
        eventCount: 0,
        endTime: Date.now() - 100,
      }),
    ]);

    const result = await tasksCommand.action!(context, '');
    if (!result || result.type !== 'message') {
      throw new Error('expected message result');
    }

    expect(result.content).toContain('Background tasks (4 total)');
    // Pluralised eventCount + pid for the running monitor.
    expect(result.content).toContain('[mon_run] running (12 events)');
    expect(result.content).toContain('pid=9999');
    expect(result.content).toContain('tail dev server log');
    // Natural completion path uses exitCode + eventCount.
    expect(result.content).toContain('[mon_done] completed (exit 0, 7 events)');
    // Auto-stop path uses the error string instead of exit code (so users
    // see WHY the monitor stopped, not just that it did).
    expect(result.content).toContain(
      '[mon_auto] completed (Max events reached, 1000 events)',
    );
    expect(result.content).toContain('[mon_fail] failed: spawn ENOENT');
    // No on-disk output file for monitors — events stream via
    // task_notification, so the "output:" line should not appear for
    // any monitor entry.
    expect(result.content).not.toContain('output: ');
  });

  it('singular form: "1 event" not "1 events"', async () => {
    getMonitors.mockReturnValue([
      monitorEntry({ monitorId: 'mon_one', eventCount: 1 }),
    ]);
    const result = await tasksCommand.action!(context, '');
    if (!result || result.type !== 'message') throw new Error('no result');
    expect(result.content).toContain('running (1 event)');
    // Guard against "1 event" matching the prefix of "1 events" by accident.
    expect(result.content).not.toContain('1 events');
  });

  it('shows the Ctrl+T hint only in interactive mode', async () => {
    getShells.mockReturnValue([entry({ shellId: 'bg_x' })]);

    // non_interactive (default in beforeEach) — no hint.
    const noHint = await tasksCommand.action!(context, '');
    if (!noHint || noHint.type !== 'message') throw new Error('no result');
    expect(noHint.content).not.toContain('Ctrl+T');

    // Re-bind the same config under an interactive context.
    const interactiveCtx = createMockCommandContext({
      executionMode: 'interactive',
      services: {
        config: {
          getBackgroundShellRegistry: () => ({ getAll: getShells }),
          getBackgroundTaskRegistry: () => ({ getAll: getAgents }),
          getMonitorRegistry: () => ({ getAll: getMonitors }),
        },
      },
    } as unknown as Parameters<typeof createMockCommandContext>[0]);
    const withHint = await tasksCommand.action!(interactiveCtx, '');
    if (!withHint || withHint.type !== 'message') throw new Error('no result');
    expect(withHint.content).toContain('Ctrl+T');
    expect(withHint.content).toContain('Background tasks (1 total)');
  });

  it('merges all three kinds and orders them by startTime', async () => {
    const now = Date.now();
    getAgents.mockReturnValue([
      agentEntry({ agentId: 'a_late', startTime: now - 1_000 }),
    ]);
    getShells.mockReturnValue([
      entry({ shellId: 'bg_early', startTime: now - 10_000 }),
    ]);
    getMonitors.mockReturnValue([
      monitorEntry({ monitorId: 'mon_mid', startTime: now - 5_000 }),
    ]);

    const result = await tasksCommand.action!(context, '');
    if (!result || result.type !== 'message') throw new Error('no result');
    const order = ['bg_early', 'mon_mid', 'a_late'].map((id) =>
      result.content.indexOf(`[${id}]`),
    );
    // All present and strictly increasing — proves startTime sort.
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });
});
