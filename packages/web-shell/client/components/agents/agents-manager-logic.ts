import type {
  DaemonWorkspaceAgentSummary,
  DaemonWorkspaceToolStatus,
} from '@qwen-code/webui/daemon-react-sdk';

export type AgentLevelFilter = 'all' | DaemonWorkspaceAgentSummary['level'];

export type AgentSelection = Pick<
  DaemonWorkspaceAgentSummary,
  'name' | 'level'
>;

export function filterAgents(
  agents: readonly DaemonWorkspaceAgentSummary[],
  query: string,
  level: AgentLevelFilter = 'all',
): DaemonWorkspaceAgentSummary[] {
  const normalized = query.trim().toLowerCase();
  return agents.filter((agent) => {
    if (level !== 'all' && agent.level !== level) return false;
    if (!normalized) return true;
    return agent.name.toLowerCase().includes(normalized);
  });
}

export function preserveAgentSelection(
  selection: AgentSelection | null,
  agents: readonly DaemonWorkspaceAgentSummary[],
): DaemonWorkspaceAgentSummary | null {
  if (!selection) return null;
  return (
    agents.find(
      (agent) =>
        agent.name === selection.name && agent.level === selection.level,
    ) ?? null
  );
}

export function isOverridden(
  agent: DaemonWorkspaceAgentSummary,
  allAgents: readonly DaemonWorkspaceAgentSummary[],
): boolean {
  if (agent.level !== 'user') return false;
  return allAgents.some((a) => a.level === 'project' && a.name === agent.name);
}

export function canModifyAgent(agent: DaemonWorkspaceAgentSummary): boolean {
  return (
    (agent.level === 'project' || agent.level === 'user') && !agent.isBuiltin
  );
}

export function scopeForLevel(
  level: string,
): 'workspace' | 'global' | undefined {
  if (level === 'project') return 'workspace';
  if (level === 'user') return 'global';
  return undefined;
}

export function normalizeToolName(tool: DaemonWorkspaceToolStatus): string {
  return tool.displayName || tool.name;
}

export function isReadTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return [
    'read',
    'grep',
    'glob',
    'ls',
    'list',
    'search',
    'fetch',
    'webfetch',
    'web_fetch',
    'websearch',
    'web_search',
    'think',
    'todo',
    'context',
  ].some((token) => normalized.includes(token));
}

export function isEditTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return ['edit', 'write', 'delete', 'move', 'patch', 'replace', 'create'].some(
    (token) => normalized.includes(token),
  );
}

export function isExecuteTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return ['shell', 'exec', 'run', 'command', 'terminal', 'bash', 'spawn'].some(
    (token) => normalized.includes(token),
  );
}
