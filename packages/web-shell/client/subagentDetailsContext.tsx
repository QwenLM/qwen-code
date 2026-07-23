import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { useConnection, useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import type { ACPToolCall } from './adapters/types';

export type OpenSubagentDetails = (tool: ACPToolCall) => void;
export type ResolveSubagentTree = (tool: ACPToolCall) => Promise<ACPToolCall>;

interface SubagentDetailsContextValue {
  onOpen: OpenSubagentDetails;
  resolveTree?: ResolveSubagentTree;
}

interface PersistedSubagentTreeNode {
  taskId: string;
  toolCallId: string;
  parentTaskId: string;
  title: string;
  status: string;
}

interface PersistedSubagentTree {
  taskId: string;
  nestedAgents?: PersistedSubagentTreeNode[];
  nestedAgentsTruncated?: boolean;
}

const SubagentDetailsContext = createContext<
  SubagentDetailsContextValue | undefined
>(undefined);

export function SubagentDetailsProvider({
  onOpen,
  resolveTree,
  children,
}: {
  onOpen: OpenSubagentDetails;
  resolveTree?: ResolveSubagentTree;
  children: ReactNode;
}) {
  return (
    <SubagentDetailsContext.Provider value={{ onOpen, resolveTree }}>
      {children}
    </SubagentDetailsContext.Provider>
  );
}

export function useSubagentDetails(): SubagentDetailsContextValue | undefined {
  return useContext(SubagentDetailsContext);
}

function persistedToolStatus(status: string): ACPToolCall['status'] {
  if (status === 'failed' || status === 'error') return 'failed';
  if (
    status === 'running' ||
    status === 'in_progress' ||
    status === 'pending' ||
    status === 'paused'
  ) {
    return 'in_progress';
  }
  return 'completed';
}

export function hydrateSubagentTree(
  root: ACPToolCall,
  resolution: PersistedSubagentTree,
): ACPToolCall {
  const byParent = new Map<string, PersistedSubagentTreeNode[]>();
  for (const agent of resolution.nestedAgents ?? []) {
    const siblings = byParent.get(agent.parentTaskId) ?? [];
    siblings.push(agent);
    byParent.set(agent.parentTaskId, siblings);
  }

  const visited = new Set([resolution.taskId]);
  const hydrate = (tool: ACPToolCall, taskId: string): ACPToolCall => {
    const existing = tool.subTools ?? [];
    const existingByCallId = new Map(
      existing.map((child) => [child.callId, child]),
    );
    const nested = [...existing];
    for (const agent of byParent.get(taskId) ?? []) {
      if (visited.has(agent.taskId)) continue;
      visited.add(agent.taskId);
      const child =
        existingByCallId.get(agent.toolCallId) ??
        ({
          callId: agent.toolCallId,
          toolName: 'Agent',
          title: agent.title,
          args: { description: agent.title },
          status: persistedToolStatus(agent.status),
          parentToolCallId: tool.callId,
          rawOutput: {
            type: 'task_execution',
            status: agent.status,
            taskDescription: agent.title,
          },
        } satisfies ACPToolCall);
      const hydrated = hydrate(child, agent.taskId);
      const existingIndex = nested.findIndex(
        (candidate) => candidate.callId === agent.toolCallId,
      );
      if (existingIndex === -1) nested.push(hydrated);
      else nested[existingIndex] = hydrated;
    }
    return nested.length > 0 ? { ...tool, subTools: nested } : tool;
  };

  return hydrate(
    resolution.nestedAgentsTruncated
      ? { ...root, subToolsTruncated: true }
      : root,
    resolution.taskId,
  );
}

export function useSubagentTreeResolver(): ResolveSubagentTree {
  const connection = useConnection();
  const workspace = useWorkspace();
  return useCallback(
    async (tool) => {
      if (!connection.sessionId) return tool;
      const resolution = await workspace.client.resolveSubagentSession(
        connection.sessionId,
        tool.callId,
        undefined,
        { includeTree: true },
      );
      return hydrateSubagentTree(tool, resolution);
    },
    [connection.sessionId, workspace.client],
  );
}
