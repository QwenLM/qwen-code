// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ACPToolCall } from './adapters/types';
import { useSubagentTreeResolver } from './subagentDetailsContext';

const mocks = vi.hoisted(() => ({
  connection: { sessionId: 'parent-session' },
  resolveSubagentSession: vi.fn(),
  workspace: {
    client: undefined as
      | { resolveSubagentSession: ReturnType<typeof vi.fn> }
      | undefined,
  },
}));
mocks.workspace.client = {
  resolveSubagentSession: mocks.resolveSubagentSession,
};

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mocks.connection,
  useWorkspace: () => mocks.workspace,
}));

function ResolverProbe({
  tool,
  onResolved,
}: {
  tool: ACPToolCall;
  onResolved: (tool: ACPToolCall) => void;
}) {
  const resolveTree = useSubagentTreeResolver();
  useEffect(() => {
    void resolveTree(tool).then(onResolved);
  }, [onResolved, resolveTree, tool]);
  return null;
}

describe('useSubagentTreeResolver', () => {
  it('requests persisted lineage and hydrates nested Agent tools', async () => {
    const rootTool: ACPToolCall = {
      callId: 'root-call',
      toolName: 'Agent',
      title: 'Root agent',
      status: 'completed',
    };
    mocks.resolveSubagentSession.mockResolvedValue({
      sessionId: 'subagent.virtual',
      taskId: 'root-task',
      title: 'Root agent',
      status: 'completed',
      nestedAgents: [
        {
          taskId: 'child-task',
          toolCallId: 'child-call',
          parentTaskId: 'root-task',
          title: 'Child agent',
          status: 'completed',
        },
      ],
    });
    const onResolved = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<ResolverProbe tool={rootTool} onResolved={onResolved} />);
      await Promise.resolve();
    });

    expect(mocks.resolveSubagentSession).toHaveBeenCalledWith(
      'parent-session',
      'root-call',
      undefined,
      { includeTree: true },
    );
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        subTools: [
          expect.objectContaining({
            callId: 'child-call',
            parentToolCallId: 'root-call',
          }),
        ],
      }),
    );

    act(() => root.unmount());
  });
});
