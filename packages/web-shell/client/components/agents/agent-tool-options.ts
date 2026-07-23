import type {
  DaemonWorkspaceMcpToolStatus,
  DaemonWorkspaceToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';

export function canAddSelection(
  selection: ReadonlySet<string>,
  value: string,
): boolean {
  return Boolean(value) && !selection.has(value);
}

export function selectBuiltInTools(
  tools: DaemonWorkspaceToolStatus[],
  mcpTools: Record<string, DaemonWorkspaceMcpToolStatus[]>,
): DaemonWorkspaceToolStatus[] {
  const mcpNames = new Set(
    Object.values(mcpTools).flatMap((items) => items.map((tool) => tool.name)),
  );
  return tools.filter(
    (tool) =>
      tool.enabled &&
      !tool.name.startsWith('mcp__') &&
      !mcpNames.has(tool.name),
  );
}

export function selectDiscoverableMcpServerNames(
  servers: Array<{
    name: string;
    disabled: boolean;
    status: string;
    mcpStatus?: 'connected' | 'connecting' | 'disconnected';
  }>,
): string[] {
  return servers
    .filter(
      (server) =>
        !server.disabled &&
        (server.mcpStatus === 'connected' ||
          (server.mcpStatus === undefined && server.status === 'ok')),
    )
    .map((server) => server.name);
}
