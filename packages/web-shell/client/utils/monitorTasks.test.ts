import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionMonitorTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../adapters/types';
import { findMonitorTaskForTool } from './monitorTasks';

function monitor(
  overrides: Partial<DaemonSessionMonitorTaskStatus> = {},
): DaemonSessionMonitorTaskStatus {
  return {
    kind: 'monitor',
    id: 'mon_0123456789abcdef',
    label: 'watch logs',
    description: 'watch logs',
    status: 'running',
    startTime: 1_000,
    runtimeMs: 500,
    command: 'tail -f app.log',
    eventCount: 1,
    lastEventTime: 1_500,
    droppedLines: 0,
    ...overrides,
  };
}

function tool(overrides: Partial<ACPToolCall> = {}): ACPToolCall {
  return {
    callId: 'monitor-call-1',
    toolName: 'monitor',
    status: 'completed',
    ...overrides,
  };
}

describe('findMonitorTaskForTool', () => {
  it('matches the monitor by its launching tool call', () => {
    const expected = monitor({ toolUseId: 'monitor-call-1' });
    const duplicate = monitor({
      id: 'mon_fedcba9876543210',
      toolUseId: 'monitor-call-2',
    });

    expect(findMonitorTaskForTool([duplicate, expected], tool())).toBe(
      expected,
    );
  });

  it('does not guess from duplicate command or description values', () => {
    const tasks: DaemonSessionTaskStatus[] = [
      monitor({ toolUseId: 'other-call' }),
    ];

    expect(
      findMonitorTaskForTool(
        tasks,
        tool({
          args: {
            command: 'tail -f app.log',
            description: 'watch logs',
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('supports legacy snapshots when the strict monitor id is in tool output', () => {
    const expected = monitor();

    expect(
      findMonitorTaskForTool(
        [expected],
        tool({
          rawOutput: 'Monitor started: watch logs (mon_0123456789abcdef)',
        }),
      ),
    ).toBe(expected);
  });

  it('does not let the legacy fallback override a conflicting tool link', () => {
    const task = monitor({ toolUseId: 'other-call' });

    expect(
      findMonitorTaskForTool(
        [task],
        tool({
          rawOutput: 'Monitor started: watch logs (mon_0123456789abcdef)',
        }),
      ),
    ).toBeUndefined();
  });
});
