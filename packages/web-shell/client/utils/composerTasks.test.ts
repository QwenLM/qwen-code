import { describe, expect, it } from 'vitest';
import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import { isComposerTask } from './composerTasks';

const base = {
  id: 'task-1',
  label: 'task',
  description: 'task',
  status: 'running' as const,
  startTime: 0,
  runtimeMs: 0,
};

describe('isComposerTask', () => {
  it('shows non-agent tasks and excludes agents', () => {
    const tasks: Array<[DaemonSessionTaskStatus, boolean]> = [
      [
        {
          ...base,
          kind: 'agent',
          isBackgrounded: false,
          subagentType: 'general-purpose',
        },
        false,
      ],
      [
        {
          ...base,
          kind: 'agent',
          isBackgrounded: true,
          subagentType: 'general-purpose',
        },
        false,
      ],
      [
        {
          ...base,
          kind: 'shell',
          command: 'npm test',
          cwd: '/workspace',
        },
        true,
      ],
      [
        {
          ...base,
          kind: 'monitor',
          command: 'watch logs',
          eventCount: 0,
          lastEventTime: 0,
          droppedLines: 0,
        },
        true,
      ],
    ];

    for (const [task, expected] of tasks) {
      expect(isComposerTask(task)).toBe(expected);
    }
  });
});
