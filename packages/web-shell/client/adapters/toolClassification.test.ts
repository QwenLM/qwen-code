import { describe, expect, it } from 'vitest';
import type { ACPToolCall } from './types';
import {
  backgroundShellTaskId,
  isActiveToolStatus,
  isBackgroundSubAgentToolCall,
} from './toolClassification';

function agentTool(args: Record<string, unknown> = {}): ACPToolCall {
  return {
    callId: 'agent-1',
    toolName: 'agent',
    args,
    status: 'completed',
  };
}

describe('isActiveToolStatus', () => {
  it.each(['pending', 'in_progress', 'running'])(
    'treats %s as active',
    (status) => {
      expect(isActiveToolStatus(status)).toBe(true);
    },
  );

  it.each(['completed', 'failed'])('treats %s as terminal', (status) => {
    expect(isActiveToolStatus(status)).toBe(false);
  });
});

describe('isBackgroundSubAgentToolCall', () => {
  it('waits for agent args before inferring the default background mode', () => {
    expect(
      isBackgroundSubAgentToolCall({
        callId: 'agent-1',
        toolName: 'agent',
        status: 'pending',
      }),
    ).toBe(false);
  });

  it('treats an ordinary agent as background when the flag is omitted', () => {
    expect(isBackgroundSubAgentToolCall(agentTool())).toBe(true);
  });

  it('does not infer fork background status from args alone', () => {
    // Args alone do not expose whether the runtime is interactive or headless.
    // The effective background status is covered by the rawOutput test below.
    expect(
      isBackgroundSubAgentToolCall(agentTool({ subagent_type: 'fork' })),
    ).toBe(false);
  });

  it('keeps an explicit foreground agent out of the background group', () => {
    expect(
      isBackgroundSubAgentToolCall(agentTool({ run_in_background: false })),
    ).toBe(false);
  });

  it('keeps caller-owned working_dir launches in the foreground by default', () => {
    expect(
      isBackgroundSubAgentToolCall(
        agentTool({ working_dir: '.qwen/worktrees/review' }),
      ),
    ).toBe(false);
  });

  it('does not change named teammate classification', () => {
    expect(isBackgroundSubAgentToolCall(agentTool({ name: 'reviewer' }))).toBe(
      false,
    );
  });

  it.each([undefined, true])(
    'keeps nested Agent calls in the foreground when the flag is %s',
    (runInBackground) => {
      expect(
        isBackgroundSubAgentToolCall({
          ...agentTool(
            runInBackground === undefined
              ? {}
              : { run_in_background: runInBackground },
          ),
          parentToolCallId: 'parent-agent',
        }),
      ).toBe(false);
    },
  );

  it('trusts the runtime background status when present', () => {
    expect(
      isBackgroundSubAgentToolCall({
        ...agentTool({ run_in_background: false }),
        rawOutput: { type: 'task_execution', status: 'background' },
      }),
    ).toBe(true);
  });

  it('trusts the runtime background execution mode over foreground args', () => {
    expect(
      isBackgroundSubAgentToolCall({
        ...agentTool({ run_in_background: false }),
        executionMode: 'background',
      }),
    ).toBe(true);
  });

  it('trusts the runtime foreground execution mode over background args', () => {
    expect(
      isBackgroundSubAgentToolCall({
        ...agentTool({ run_in_background: true }),
        executionMode: 'foreground',
      }),
    ).toBe(false);
  });
});

describe('backgroundShellTaskId', () => {
  it.each([
    ['Background shell bg_1234abcd started.', 'bg_1234abcd'],
    ['background shell bg_1234abcd started.', 'bg_1234abcd'],
    ['Promoted to background: bg_abcd-1234', 'bg_abcd-1234'],
  ])('extracts the task id from %s', (rawOutput, taskId) => {
    expect(
      backgroundShellTaskId({
        callId: 'shell-1',
        toolName: 'shell',
        status: 'completed',
        rawOutput,
      }),
    ).toBe(taskId);
  });

  it('ignores failed shell calls', () => {
    expect(
      backgroundShellTaskId({
        callId: 'shell-1',
        toolName: 'shell',
        status: 'failed',
        rawOutput: 'Background shell bg_1234abcd started.',
      }),
    ).toBeUndefined();
  });

  it('ignores non-shell tool names', () => {
    expect(
      backgroundShellTaskId({
        callId: 'read-1',
        toolName: 'Read',
        status: 'completed',
        rawOutput: 'Background shell bg_1234abcd started.',
      }),
    ).toBeUndefined();
  });

  it('ignores non-string rawOutput', () => {
    expect(
      backgroundShellTaskId({
        callId: 'shell-1',
        toolName: 'shell',
        status: 'completed',
        rawOutput: { taskId: 'bg_1234abcd' },
      }),
    ).toBeUndefined();
  });
});
