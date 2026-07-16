import { describe, expect, it } from 'vitest';
import type { ACPToolCall } from './types';
import { isBackgroundSubAgentToolCall } from './toolClassification';

function agentTool(args: Record<string, unknown> = {}): ACPToolCall {
  return {
    callId: 'agent-1',
    toolName: 'agent',
    args,
    status: 'completed',
  };
}

describe('isBackgroundSubAgentToolCall', () => {
  it('treats an ordinary agent as background when the flag is omitted', () => {
    expect(isBackgroundSubAgentToolCall(agentTool())).toBe(true);
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
});
