import { describe, expect, it } from 'vitest';
import type { ACPToolCall, Message } from '../adapters/types';
import { getTaskActivityKey, hasActiveTaskActivity } from './taskActivity';

function monitorCall(
  callId: string,
  status: ACPToolCall['status'],
): ACPToolCall {
  return { callId, toolName: 'monitor', status, kind: 'execute' };
}

function group(...tools: ACPToolCall[]): Message {
  return { id: `m-${tools[0]?.callId ?? 'empty'}`, role: 'tool_group', tools };
}

describe('hasActiveTaskActivity', () => {
  it('reports activity from the tool call status, not from the rendered key', () => {
    // `callId` is unconstrained text and the key is `callId:status` joined
    // with '|', so the rendering is not injective: this completed call
    // renders a key that reads as in_progress to any regex over it. Both
    // polling stop conditions hang off this verdict, so a false positive
    // keeps the session polling every 3s for as long as the view is
    // mounted.
    const messages = [group(monitorCall('x:in_progress|y', 'completed'))];

    expect(getTaskActivityKey(messages)).toBe('x:in_progress|y:completed');
    expect(
      /:(?:pending|in_progress)(?:\||$)/.test(getTaskActivityKey(messages)),
    ).toBe(true);
    expect(hasActiveTaskActivity(messages)).toBe(false);
  });

  it('reports a genuinely running call as active', () => {
    expect(
      hasActiveTaskActivity([group(monitorCall('a', 'in_progress'))]),
    ).toBe(true);
    expect(hasActiveTaskActivity([group(monitorCall('a', 'pending'))])).toBe(
      true,
    );
    expect(hasActiveTaskActivity([group(monitorCall('a', 'completed'))])).toBe(
      false,
    );
    expect(hasActiveTaskActivity([])).toBe(false);
  });

  it('ignores workflow calls when the workflows endpoint is off', () => {
    // With the flag off the hook polls getTasks(), which structurally
    // excludes workflow tasks — so a live workflow call can never show up
    // in a snapshot and holding activity open on it would make both
    // polling stop conditions unsatisfiable for the rest of the run.
    const workflow: ACPToolCall = {
      callId: 'wf-1',
      toolName: 'workflow',
      status: 'in_progress',
      kind: 'execute',
    };
    expect(hasActiveTaskActivity([group(workflow)])).toBe(false);
    expect(
      hasActiveTaskActivity([group(workflow)], { workflowsEnabled: true }),
    ).toBe(true);
    // Other background kinds are observable through either endpoint.
    expect(
      hasActiveTaskActivity([group(monitorCall('m', 'in_progress'))]),
    ).toBe(true);
  });

  it('walks nested sub-tools, like the key does', () => {
    const parent: ACPToolCall = {
      ...monitorCall('parent', 'completed'),
      subTools: [monitorCall('child', 'in_progress')],
    };
    expect(hasActiveTaskActivity([group(parent)])).toBe(true);
    expect(getTaskActivityKey([group(parent)])).toBe(
      'parent:completed|child:in_progress',
    );
  });
});
