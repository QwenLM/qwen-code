import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QwenAgent } from '../qwen-agent.ts';

type BackendConfig = ConstructorParameters<typeof QwenAgent>[0];

type QwenToolUpdateInternals = {
  handleToolCallUpdate: (update: Record<string, unknown>) => void;
  eventQueue: {
    drain: () => AsyncIterator<{ type: string; [key: string]: unknown }>;
  };
};

function createAgent(cwd: string): QwenAgent {
  return new QwenAgent({
    provider: 'qwen',
    workspace: {
      id: 'workspace-qwen',
      name: 'Qwen Workspace',
      slug: 'qwen-workspace',
      rootPath: cwd,
      createdAt: Date.now(),
    },
    session: {
      id: 'session-qwen',
      name: 'Qwen Session',
      workspaceRootPath: cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
  } as BackendConfig);
}

describe('QwenAgent tool_call_update handling', () => {
  it('ignores in_progress heartbeat frames and only emits tool_result on completion', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-agent-tool-updates-'));
    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenToolUpdateInternals;

    // A silent-shell liveness heartbeat: in_progress, meta-only. Converting
    // it into a tool_result would prematurely complete the call.
    internals.handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'in_progress',
      _meta: {
        toolName: 'run_shell_command',
        shellProgress: { type: 'shell_progress', elapsedMs: 10_000 },
      },
    });

    // The real terminal update still produces a tool_result.
    internals.handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'done' } },
      ],
      _meta: { toolName: 'run_shell_command' },
    });

    const iterator = internals.eventQueue.drain();
    const first = await iterator.next();
    await iterator.return?.(undefined);

    // The first (and only) queued event is the terminal result — the
    // heartbeat produced nothing. Pin `result` to the completed frame's
    // payload ('done'): a dropped guard would instead enqueue the heartbeat
    // as the first tool_result with result 'Tool completed' (and isError
    // false), so asserting only type + isError would stay green through the
    // regression — the result assertion is what actually gates the guard.
    expect(first.value?.type).toBe('tool_result');
    expect(first.value?.isError).toBe(false);
    expect(first.value?.result).toBe('done');
  });

  it('does not drop an in_progress frame that carries a kind', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'qwen-agent-tool-updates-'));
    const agent = createAgent(cwd);
    const internals = agent as unknown as QwenToolUpdateInternals;

    // The drop guard is scoped to kind-less heartbeats (matching the
    // web-shell normalizer): an in_progress frame WITH a kind is not a bare
    // heartbeat and must still flow through to a tool_result.
    internals.handleToolCallUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'in_progress',
      kind: 'execute',
      _meta: {
        toolName: 'run_shell_command',
        shellProgress: { type: 'shell_progress', elapsedMs: 10_000 },
      },
    });

    const iterator = internals.eventQueue.drain();
    const first = await iterator.next();
    await iterator.return?.(undefined);
    expect(first.value?.type).toBe('tool_result');
  });
});
